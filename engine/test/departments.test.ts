import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuardServer, COOKIE_NAME } from "../src/server/server.ts";
import type { ServerDeps } from "../src/server/server.ts";
import { openDb } from "../src/index/db.ts";
import { indexVault } from "../src/index/notes.ts";
import { ingestDocSources } from "../src/ingest/index.ts";
import { readFolderDocs } from "../src/ingest/files.ts";
import { ModelError, parseDepartment, parseRegistry, pathProblem } from "../src/departments/model.ts";
import {
  RegistryConflictError, addDepartment, archiveDepartment, cfgFor, loadRegistry, purgeStorage, registryPath,
  resolveDepartment, saveRegistry, updateRegistry,
} from "../src/departments/registry.ts";
import { loadSeedFile, seedDepartments, seedFilePath } from "../src/departments/seed.ts";
import { mcpConfig } from "../src/mcp/server.ts";
import { tmpCfg } from "./chat-helpers.ts";
import type { GuardConfig } from "../src/types.ts";

const TOKEN = "t".repeat(48);
const usage = { input_tokens: 1, output_tokens: 1 };
const MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

function tmpDir(name = "dept-"): string {
  return mkdtempSync(join(tmpdir(), name));
}

function docsFolder(files: Record<string, string>): string {
  const dir = tmpDir("docs-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const note = (id: string, status: string, title: string, body: string): string =>
  `---\nid: ${id}\ntype: rule\nstatus: ${status}\naudience: [internal_dev]\ndepartment: dev\nsource: owner-answer\ncreated: 2026-11-01\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;

/** Two departments, each with its own vault note, report and indexed docs. Returns the base config. */
function twoDepartments(): { base: GuardConfig; a: string; b: string } {
  const base = tmpCfg();
  mkdirSync(base.vaultDir, { recursive: true });
  const docsA = docsFolder({ "alpha.md": "# Alpha\n\nThe zebra procedure is private to alpha." });
  const docsB = docsFolder({ "beta.md": "# Beta\n\nThe giraffe procedure belongs to beta." });
  addDepartment(base, { id: "alpha", name: "Alpha", template: "knowledge", sources: [{ kind: "docs", label: "Alpha docs", path: docsA }] });
  addDepartment(base, { id: "beta", name: "Beta", template: "knowledge", sources: [{ kind: "docs", label: "Beta docs", path: docsB }] });
  for (const [id, notes, report] of [
    ["alpha", [note("rule-alpha", "active", "Alpha rule about zebra", "Zebra rules apply."), note("draft-alpha", "proposed", "Alpha draft", "Zebra draft.")], "alpha report"],
    ["beta", [note("rule-beta", "active", "Beta rule about giraffe", "Giraffe rules apply.")], "beta report"],
  ] as const) {
    const r = resolveDepartment(loadRegistry(base), id);
    for (const n of notes) writeFileSync(join(r.paths.vaultDir, "rules", `${/id: ([a-z-]+)/.exec(n)![1]}.md`), n);
    mkdirSync(join(r.paths.dataDir, "reviews"), { recursive: true });
    writeFileSync(join(r.paths.dataDir, "reviews", `${id}.md`), `# ${report}`);
    const db = openDb(r.paths.dbFile);
    indexVault(db, r.cfg.vaultDir);
    ingestDocSources(db, r.cfg);
    db.close();
  }
  return { base, a: "alpha", b: "beta" };
}

/* ---------------- model ---------------- */

test("model: bad ids, names and paths are refused", () => {
  const ok = { name: "Eng", template: "engineering", roles: {}, createdAt: "x" };
  assert.throws(() => parseDepartment({ ...ok, id: "Bad Id" }), ModelError);
  assert.throws(() => parseDepartment({ ...ok, id: "a" }), ModelError, "too short");
  assert.throws(() => parseDepartment({ ...ok, id: "x".repeat(41) }), ModelError, "too long");
  assert.throws(() => parseDepartment({ ...ok, id: "ok-id", name: "" }), ModelError);
  assert.throws(() => parseDepartment({ ...ok, id: "ok-id", template: "nope" }), ModelError);
  assert.throws(() => parseDepartment({ ...ok, id: "ok-id", color: "pink" }), ModelError);
  for (const p of ["\\\\server\\share\\x", "//server/share", "relative/dir", "..\\x", "D:\\a\\..\\b", "https://example.com/x", "file:///x", "", "D:", "C:foo"]) {
    assert.notEqual(pathProblem(p), null, p);
  }
  for (const p of ["D:\\SPIL AURA", "C:/work/repo", "/home/me/repo"]) assert.equal(pathProblem(p), null, p);
  assert.throws(() => parseDepartment({ ...ok, id: "ok-id", sources: [{ kind: "docs", label: "x", path: "\\\\host\\share" }] }), /Network paths/);
});

test("model: ids are generated from names and must be unique inside their parent", () => {
  const d = parseDepartment({
    id: "eng", name: "Eng", template: "custom", roles: {}, createdAt: "x",
    modules: [
      { name: "Core Module", subModules: [{ name: "Part One" }, { name: "Part One" }] },
      { name: "Core Module" },
    ],
  });
  assert.deepEqual(d.modules.map((m) => m.id), ["core-module", "core-module-2"]);
  assert.deepEqual(d.modules[0]!.subModules.map((s) => s.id), ["part-one", "part-one-2"]);
  assert.throws(() => parseDepartment({ id: "eng", name: "E", template: "custom", roles: {}, createdAt: "x", modules: [{ id: "m-1", name: "a" }, { id: "m-1", name: "b" }] }), /used twice/);
  assert.throws(() => parseRegistry({ version: 1, defaultDepartment: "a-1", departments: [
    d && { ...d, id: "a-1" }, { ...d, id: "a-1" },
  ] }), /used twice/);
});

/* ---------------- registry ---------------- */

test("registry: atomic write keeps a .bak and rejects a stale etag", () => {
  const base = tmpCfg();
  const first = addDepartment(base, { name: "One", template: "custom" });
  const reg1 = loadRegistry(base);
  assert.equal(reg1.synthesized, false);
  assert.equal(reg1.etag, first.etag);
  assert.ok(!existsSync(registryPath(base) + ".tmp"), "no temp file is left");
  assert.ok(!existsSync(registryPath(base) + ".bak"), "nothing to back up yet");
  const second = addDepartment(base, { name: "Two", template: "custom" });
  assert.ok(existsSync(registryPath(base) + ".bak"));
  assert.equal(JSON.parse(readFileSync(registryPath(base) + ".bak", "utf8")).departments.length, 2, "the .bak holds the previous version");
  assert.notEqual(second.etag, first.etag);
  // A writer holding the old etag is refused.
  assert.throws(() => saveRegistry(base, reg1.data, first.etag), RegistryConflictError);
  assert.throws(() => updateRegistry(base, () => {}, first.etag), RegistryConflictError);
  assert.doesNotThrow(() => updateRegistry(base, () => {}, second.etag));
});

test("registry: without a file one legacy department is derived from the config", () => {
  const base = tmpCfg();
  base.repos = [{ id: "main-repo", path: join(tmpdir(), "x") }];
  const reg = loadRegistry(base);
  assert.equal(reg.synthesized, true);
  assert.equal(reg.data.defaultDepartment, "default");
  const r = resolveDepartment(reg, undefined);
  assert.equal(r.paths.legacy, true);
  assert.equal(r.cfg.dataDir, base.dataDir);
  assert.equal(r.cfg.vaultDir, base.vaultDir);
  assert.deepEqual(r.cfg.repos.map((x) => ({ id: x.id, path: x.path })), [{ id: "main-repo", path: base.repos[0]!.path }]);
  assert.equal(r.cfg.department, base.department);
  assert.throws(() => resolveDepartment(reg, "nope"), /no department/);
});

test("registry: a department gets its own folders and cfgFor flattens every git source", () => {
  const base = tmpCfg();
  const git = tmpDir("git-");
  const docs = tmpDir("docs-");
  const { department } = addDepartment(base, {
    name: "Shape Team", template: "engineering",
    sources: [{ kind: "git", label: "Top", path: git }],
    modules: [{ name: "Shape", sources: [{ kind: "docs", label: "Notes", path: docs }], subModules: [{ name: "Core", sources: [{ kind: "git", label: "Core", path: git }] }] }],
  });
  assert.equal(department.id, "shape-team");
  const r = resolveDepartment(loadRegistry(base), "shape-team");
  assert.deepEqual(r.cfg.repos.map((x) => x.id), ["top", "core"]);
  assert.equal(r.cfg.repos[1]!.sub, "Core");
  assert.deepEqual(r.cfg.docSources?.map((x) => x.id), ["notes"]);
  assert.equal(r.cfg.departmentId, "shape-team");
  assert.equal(r.cfg.dataDir, join(base.dataDir, "departments", "shape-team"));
  assert.equal(r.cfg.vaultDir, join(r.cfg.dataDir, "vault"));
  for (const f of ["rules", "adr", "patterns", "domain", "diary", "choices", "incidents", "journeys", "support", "inbox"]) {
    assert.ok(existsSync(join(r.cfg.vaultDir, f)), f);
  }
  assert.deepEqual(cfgFor(department, base).roles, department.roles);
  assert.equal(department.roles.reviewer, true, "engineering template switches reviewer on");
  assert.throws(() => addDepartment(base, { id: "shape-team", name: "Again", template: "custom" }), /already exists/);
});

/* ---------------- docs ingest ---------------- */

test("docs folder ingest: filters, hashes, deletions and caps", () => {
  const dir = docsFolder({
    "a.md": "# A\nalpha text", "sub/b.txt": "beta text", "c.rst": "gamma", "d.mdx": "delta", "skip.js": "no",
    ".hidden/x.md": "hidden", "node_modules/p/readme.md": "dep",
  });
  writeFileSync(join(dir, "huge.md"), "x".repeat(300 * 1024));
  const docs = readFolderDocs(dir).map((d) => d.path).sort();
  assert.deepEqual(docs, ["a.md", "c.rst", "d.mdx", "sub/b.txt"]);

  const db = openDb(":memory:");
  const cfg: GuardConfig = { ...tmpCfg(), docSources: [{ id: "kb", path: dir }] };
  const r1 = ingestDocSources(db, cfg)[0]!;
  assert.deepEqual(r1.fileDocs, { added: 4, changed: 0, removed: 0 });
  assert.ok(db.prepare("SELECT 1 FROM docs WHERE ref='kb:sub/b.txt' AND kind='file'").get());
  const r2 = ingestDocSources(db, cfg)[0]!;
  assert.deepEqual(r2.fileDocs, { added: 0, changed: 0, removed: 0 }, "same hashes are skipped");
  writeFileSync(join(dir, "a.md"), "# A\nchanged");
  rmSync(join(dir, "c.rst"));
  const r3 = ingestDocSources(db, cfg)[0]!;
  assert.deepEqual(r3.fileDocs, { added: 0, changed: 1, removed: 1 });
  assert.equal(ingestDocSources(db, { ...cfg, docSources: [{ id: "gone", path: join(dir, "nope") }] })[0]!.skipped, "folder not found");
});

/* ---------------- seed ---------------- */

test("seed: idempotent, and only sources whose folder exists are created", () => {
  const base = tmpCfg();
  const folderA = mkdtempSync(join(tmpdir(), "seed-a-"));
  const folderB = mkdtempSync(join(tmpdir(), "seed-b-"));
  const seed = [
    { id: "alpha", name: "Alpha", template: "engineering" as const, color: "violet" as const, storage: "legacy" as const, modules: [{ name: "Core", sources: [{ id: "a-repo", label: "A repo", path: folderA }] }] },
    { id: "beta", name: "Beta", template: "engineering" as const, color: "teal" as const, modules: [{ name: "Svc", subModules: [{ name: "One" }, { name: "Two", sources: [{ id: "b-repo", label: "B repo", path: folderB }] }] }] },
    { id: "docs", name: "Docs", template: "support" as const, color: "rose" as const },
  ];
  const r1 = seedDepartments(base, seed);
  assert.equal(r1.alreadySeeded, false);
  assert.deepEqual(r1.report.map((x) => x.id), seed.map((s) => s.id));
  const reg = loadRegistry(base);
  assert.equal(reg.data.defaultDepartment, "alpha");
  assert.equal(reg.data.departments.find((d) => d.id === "alpha")!.storage, "legacy");
  for (const d of reg.data.departments) {
    for (const p of [...d.sources, ...d.modules.flatMap((m) => [...m.sources, ...m.subModules.flatMap((s) => s.sources)])]) {
      assert.ok(existsSync(p.path), `${d.id}: ${p.path} must exist`);
    }
  }
  assert.equal(r1.report.find((x) => x.id === "docs")!.needsSources, true);
  const etag = reg.etag;
  assert.equal(seedDepartments(base, seed).alreadySeeded, true);
  assert.equal(loadRegistry(base).etag, etag, "a second run changes nothing");
  // A seed folder that does not exist is left out and named.
  const base2 = tmpCfg();
  const r = seedDepartments(base2, [{ id: "one", name: "One", template: "engineering", color: "teal", modules: [{ name: "M", sources: [{ id: "gone", label: "Gone", path: join(tmpdir(), "no-such-folder-xyz") }] }] }]);
  assert.deepEqual(r.report[0]!.missing, ["Gone"]);
  assert.equal(r.report[0]!.needsSources, true);
});

/* ---------------- purge ---------------- */

test("purge removes only that department's folder and never the legacy storage", () => {
  const { base } = twoDepartments();
  const reg = loadRegistry(base);
  const alpha = reg.data.departments.find((d) => d.id === "alpha")!;
  const beta = resolveDepartment(reg, "beta");
  assert.equal(purgeStorage(alpha, base), true);
  assert.ok(!existsSync(join(base.dataDir, "departments", "alpha")));
  assert.ok(existsSync(join(beta.paths.vaultDir, "rules", "rule-beta.md")));
  assert.ok(existsSync(beta.paths.dbFile));
  const legacy = { ...alpha, id: "old-one", storage: "legacy" as const };
  mkdirSync(base.vaultDir, { recursive: true });
  assert.throws(() => purgeStorage(legacy, base), /never deleted/);
  assert.ok(existsSync(base.vaultDir));
  assert.throws(() => archiveDepartment(base, "default", { purge: true }), /never deleted/, "the derived legacy department");
});

/* ---------------- HTTP ---------------- */

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function http(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: o.path, method: o.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...o.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(o.body);
  });
}

async function start(base: GuardConfig, over: Partial<ServerDeps> = {}) {
  const prompts: string[] = [];
  const argvs: string[][] = [];
  const server = createGuardServer(base, {
    token: TOKEN,
    complete: async (req) => {
      prompts.push([...req.system, req.user].join("\n"));
      return { text: "Answer", usage };
    },
    runProcess: async (argv) => { argvs.push(argv); return { code: 0, stdout: "ok", stderr: "" }; },
    commandTable: async () => new Set(),
    backendInfo: async () => ({ wanted: "auto", picked: "claude-cli", label: "Claude plan" }),
    ...over,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const auth = { Cookie: `${COOKIE_NAME}=${TOKEN}` };
  const get = (path: string) => http(port, { path, headers: auth });
  const send = (method: string, path: string, obj: unknown, extra: Record<string, string> = {}) =>
    http(port, { path, method, headers: { ...auth, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(JSON.stringify(obj))), ...extra }, body: JSON.stringify(obj) });
  const json = async <T>(r: Promise<Res>): Promise<T> => JSON.parse((await r).body) as T;
  return { port, prompts, argvs, get, send, json, auth, stop: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("isolation: every endpoint answers from the chosen department only", async () => {
  const { base } = twoDepartments();
  const s = await start(base);
  try {
    // doc lookup
    assert.equal((await s.get("/api/doc?ref=rule-alpha&dept=alpha")).status, 200);
    assert.equal((await s.get("/api/doc?ref=rule-alpha&dept=beta")).status, 404);
    assert.equal((await s.get("/api/doc?ref=alpha-docs:alpha.md&dept=beta")).status, 404);
    assert.equal((await s.get("/api/doc?ref=beta-docs:beta.md&dept=alpha")).status, 404);
    assert.equal((await s.get("/api/doc?ref=beta-docs:beta.md&dept=beta")).status, 200);
    // status
    const st = await s.json<{ index: Record<string, number>; vault: { notes: number }; department: { id: string }; productName: string }>(s.get("/api/status?dept=beta"));
    assert.equal(st.department.id, "beta");
    assert.equal(st.vault.notes, 1);
    assert.equal(st.index["file"], 1);
    assert.equal(st.productName, "SPIL Quality Support Bot");
    assert.equal((await s.json<{ vault: { notes: number } }>(s.get("/api/status?dept=alpha"))).vault.notes, 2);
    // inbox
    assert.equal((await s.json<{ total: number }>(s.get("/api/inbox?dept=alpha"))).total, 1);
    assert.equal((await s.json<{ total: number }>(s.get("/api/inbox?dept=beta"))).total, 0);
    assert.equal((await s.get("/api/inbox/note?id=draft-alpha&dept=beta")).status, 404);
    assert.equal((await s.get("/api/inbox/note?id=draft-alpha&dept=alpha")).status, 200);
    assert.equal((await s.send("POST", "/api/notes/draft-alpha/status", { to: "active", dept: "beta" })).status, 404, "cannot approve another department's note");
    // reports
    const ra = await s.json<{ reports: { path: string }[] }>(s.get("/api/reports?dept=alpha"));
    assert.deepEqual(ra.reports.map((r) => r.path), ["reviews/alpha.md"]);
    assert.deepEqual((await s.json<{ reports: { path: string }[] }>(s.get("/api/reports?dept=beta"))).reports.map((r) => r.path), ["reviews/beta.md"]);
    assert.equal((await s.get("/api/report?path=reviews/alpha.md&dept=beta")).status, 404);
    assert.equal((await s.get("/api/report?path=reviews/alpha.md&dept=alpha")).status, 200);
    // chats
    const chat = await s.json<{ id: string }>(s.send("POST", "/api/chats", { dept: "alpha" }));
    assert.equal((await s.json<{ chats: unknown[] }>(s.get("/api/chats?dept=alpha"))).chats.length, 1);
    assert.equal((await s.json<{ chats: unknown[] }>(s.get("/api/chats?dept=beta"))).chats.length, 0);
    assert.equal((await s.get(`/api/chats/${chat.id}?dept=beta`)).status, 404);
    assert.equal((await s.get(`/api/chats/${chat.id}?dept=alpha`)).status, 200);
    assert.equal((await s.send("POST", `/api/chats/${chat.id}/ask`, { question: "giraffe", dept: "beta" })).status, 404, "alpha's chat id does not exist in beta");
    // answer: the model only sees the asked department's sources
    const cb = await s.json<{ id: string }>(s.send("POST", "/api/chats", { dept: "beta" }));
    const ans = await s.send("POST", `/api/chats/${cb.id}/ask`, { question: "What is the giraffe or zebra procedure?", dept: "beta" });
    assert.equal(ans.status, 200);
    const prompt = s.prompts.at(-1)!;
    assert.ok(prompt.includes("giraffe"));
    assert.ok(!prompt.toLowerCase().includes("zebra procedure is private"), "alpha's text never reaches beta's prompt");
    assert.ok(!prompt.includes("rule-alpha"));
    // files on disk
    const regs = loadRegistry(base);
    assert.ok(existsSync(join(resolveDepartment(regs, "alpha").paths.chatsDir, `${chat.id}.json`)));
    assert.ok(!existsSync(join(resolveDepartment(regs, "beta").paths.chatsDir, `${chat.id}.json`)));
  } finally {
    await s.stop();
  }
});

test("departments in requests: unknown is 404, archived is readable but not writable (410), commands carry --dept", async () => {
  const { base } = twoDepartments();
  const s = await start(base);
  try {
    assert.equal((await s.get("/api/status?dept=nope")).status, 404);
    assert.equal((await s.send("POST", "/api/chats", { dept: "nope" })).status, 404);
    // the first request without dept uses the registry default (the legacy department)
    assert.equal((await s.json<{ department: { id: string } }>(s.get("/api/status"))).department.id, "default");
    await s.send("POST", "/api/command", { line: "/status", dept: "beta" });
    await s.send("POST", "/api/command", { line: "/index", dept: "alpha" });
    assert.deepEqual(s.argvs, [["status", "--dept", "beta"], ["index", "--dept", "alpha"]]);
    assert.equal((await s.send("POST", "/api/command", { line: "/check", dept: "beta" })).status, 200);
    assert.equal((await s.send("POST", "/api/command", { line: "/review --dept alpha", dept: "beta" })).status, 400);
    const etag = (await s.json<{ etag: string }>(s.get("/api/departments"))).etag;
    assert.equal((await s.send("DELETE", "/api/departments/beta", { confirm: "beta" })).status, 200);
    assert.notEqual(etag, (await s.json<{ etag: string }>(s.get("/api/departments"))).etag);
    assert.equal((await s.get("/api/status?dept=beta")).status, 200);
    assert.equal((await s.send("POST", "/api/chats", { dept: "beta" })).status, 410);
    assert.equal((await s.send("POST", "/api/command", { line: "/status", dept: "beta" })).status, 410);
    assert.equal((await s.send("POST", "/api/chats", { dept: "alpha" })).status, 201);
  } finally {
    await s.stop();
  }
});

test("without a registry the server behaves as before: one default department, argv unchanged", async () => {
  const base = tmpCfg();
  const s = await start(base);
  try {
    const list = await s.json<{ defaultDepartment: string; departments: { id: string }[] }>(s.get("/api/departments"));
    assert.equal(list.defaultDepartment, "default");
    assert.deepEqual(list.departments.map((d) => d.id), ["default"]);
    await s.send("POST", "/api/command", { line: "/status" });
    assert.deepEqual(s.argvs, [["status"]]);
    assert.equal((await s.send("POST", "/api/chats", {})).status, 201);
    assert.ok(existsSync(join(base.dataDir, "chats")), "chats still live in data/chats");
    // creating the first real department keeps the legacy one in the file
    const r = await s.send("POST", "/api/departments", { name: "New Team", template: "support" });
    assert.equal(r.status, 201);
    const after = await s.json<{ departments: { id: string }[] }>(s.get("/api/departments"));
    assert.deepEqual(after.departments.map((d) => d.id), ["default", "new-team"]);
  } finally {
    await s.stop();
  }
});

test("API contract: list, create, read, edit, check, archive, purge", async () => {
  const { base } = twoDepartments();
  const docs = docsFolder({ "x.md": "# x", "y.txt": "y" });
  const s = await start(base);
  try {
    // 401 without the cookie; 403 for a foreign origin
    assert.equal((await http(s.port, { path: "/api/departments" })).status, 401);
    assert.equal((await http(s.port, { path: "/api/departments", headers: { ...s.auth, Host: "evil.example" } })).status, 403);
    assert.equal((await s.send("POST", "/api/departments", { name: "X", template: "custom" }, { Origin: "http://evil.example" })).status, 403);

    const list = await s.json<{
      productName: string; defaultDepartment: string; etag: string;
      departments: { id: string; name: string; description: unknown; owner: unknown; template: string; color: unknown; archived: boolean; roles: Record<string, boolean>; counts: { modules: number; subModules: number; sources: number }; health: Record<string, unknown> }[];
      templates: { id: string; name: string; description: string; hint: string; roles: Record<string, boolean> }[];
    }>(s.get("/api/departments"));
    assert.equal(list.productName, "SPIL Quality Support Bot");
    assert.equal(list.defaultDepartment, "default", "the legacy department stays the default");
    assert.deepEqual(list.templates.map((t) => t.id), ["engineering", "knowledge", "support", "analysis", "custom"]);
    const alpha = list.departments.find((d) => d.id === "alpha")!;
    assert.deepEqual(Object.keys(alpha).sort(), ["archived", "color", "counts", "description", "health", "id", "name", "owner", "roles", "template"]);
    assert.deepEqual(Object.keys(alpha.health).sort(), ["active", "commits", "files", "inbox", "indexedAt", "lastDaily", "needsSources", "notes", "problems", "proposed", "qaPlans", "reviews", "stale"]);
    assert.equal(alpha.health["notes"], 2);
    assert.equal(alpha.health["files"], 1);
    assert.equal(alpha.health["proposed"], 1);
    assert.equal(alpha.health["needsSources"], false);
    assert.equal(typeof alpha.health["indexedAt"], "string");
    assert.equal(alpha.counts.sources, 1);

    // create
    assert.equal((await s.send("POST", "/api/departments", { template: "custom" })).status, 400, "name is required");
    assert.equal((await s.send("POST", "/api/departments", { name: "Bad", template: "nope" })).status, 400);
    assert.equal((await s.send("POST", "/api/departments", { name: "Bad", template: "custom", sources: [{ kind: "docs", label: "n", path: "\\\\host\\share" }] })).status, 400);
    const created = await s.send("POST", "/api/departments", { name: "Quality Team", template: "knowledge", color: "teal", sources: [{ kind: "docs", label: "Docs", path: docs }] });
    assert.equal(created.status, 201);
    const c = JSON.parse(created.body) as { department: { id: string; roles: Record<string, boolean> }; etag: string };
    assert.equal(c.department.id, "quality-team");
    assert.equal(c.department.roles["scribe"], true);
    assert.ok(existsSync(join(base.dataDir, "departments", "quality-team", "vault", "rules")));
    assert.equal((await s.json<{ department: { id: string } }>(s.send("POST", "/api/departments", { name: "Quality Team", template: "custom" }))).department.id, "quality-team-2", "generated ids stay unique");
    assert.equal((await s.send("POST", "/api/departments", { id: "quality-team", name: "Dup", template: "custom" })).status, 409);

    // read one
    const one = await s.json<{ department: { id: string }; etag: string; health: unknown; sources: { id: string; label: string; kind: string; path: string; status: { exists: boolean; isGit: boolean; docFiles?: number } }[] }>(s.get("/api/departments/quality-team"));
    assert.equal(one.sources[0]!.status.exists, true);
    assert.equal(one.sources[0]!.status.docFiles, 2);
    assert.equal(one.sources[0]!.status.isGit, false);
    assert.equal((await s.get("/api/departments/missing")).status, 404);

    // edit (whole department) with the etag; a stale etag is 409; bad body is 400
    const dept = { ...one.department, name: "Quality", modules: [{ name: "Checks", subModules: [{ name: "Daily" }], sources: [] }] };
    const put = await s.send("PUT", "/api/departments/quality-team", { department: dept, etag: one.etag });
    assert.equal(put.status, 200);
    const p = JSON.parse(put.body) as { department: { name: string; modules: { id: string; subModules: { id: string }[] }[] }; etag: string };
    assert.equal(p.department.name, "Quality");
    assert.equal(p.department.modules[0]!.id, "checks");
    assert.equal(p.department.modules[0]!.subModules[0]!.id, "daily");
    assert.equal((await s.send("PUT", "/api/departments/quality-team", { department: dept, etag: one.etag })).status, 409, "stale etag");
    assert.equal((await s.send("PUT", "/api/departments/quality-team", { department: { ...dept, name: "" }, etag: p.etag })).status, 400);
    assert.equal((await s.send("PUT", "/api/departments/quality-team", { department: dept })).status, 400, "etag is required");
    assert.equal((await s.send("PUT", "/api/departments/quality-team", { department: { ...dept, sources: [{ kind: "docs", label: "x", path: "..\\x" }] }, etag: p.etag })).status, 400);

    // source check
    const chk = await s.json<{ exists: boolean; isGit: boolean; docFiles?: number }>(s.send("POST", "/api/departments/quality-team/sources/check", { path: docs, kind: "docs" }));
    assert.deepEqual(chk, { exists: true, isGit: false, docFiles: 2 });
    const none = await s.json<{ exists: boolean; error?: string }>(s.send("POST", "/api/departments/quality-team/sources/check", { path: join(docs, "missing"), kind: "docs" }));
    assert.equal(none.exists, false);
    assert.ok(none.error);
    const unc = await s.json<{ exists: boolean; error?: string }>(s.send("POST", "/api/departments/quality-team/sources/check", { path: "\\\\host\\share", kind: "docs" }));
    assert.equal(unc.exists, false);
    assert.match(unc.error ?? "", /Network/);
    assert.equal((await s.send("POST", "/api/departments/quality-team/sources/check", { path: docs, kind: "zip" })).status, 400);
    assert.equal((await s.send("POST", "/api/departments/missing/sources/check", { path: docs, kind: "docs" })).status, 404);
    const gitDir = tmpDir("git-");
    execFileSync("git", ["init", "-q"], { cwd: gitDir });
    const g = await s.json<{ isGit: boolean }>(s.send("POST", "/api/departments/quality-team/sources/check", { path: gitDir, kind: "git" }));
    assert.equal(g.isGit, true);

    // delete: confirm is required; archive by default; purge refuses legacy storage
    assert.equal((await s.send("DELETE", "/api/departments/quality-team", { confirm: "wrong" })).status, 400);
    assert.equal((await s.send("DELETE", "/api/departments/quality-team", {})).status, 400);
    const arch = await s.json<{ archived: boolean; purged: boolean }>(s.send("DELETE", "/api/departments/quality-team", { confirm: "quality-team" }));
    assert.deepEqual([arch.archived, arch.purged], [true, false]);
    const archived = (await s.json<{ departments: { id: string; archived: boolean }[] }>(s.get("/api/departments"))).departments.find((d) => d.id === "quality-team")!;
    assert.equal(archived.archived, true);
    assert.ok(existsSync(join(base.dataDir, "departments", "quality-team")), "archive keeps the folder");
    const purged = await s.json<{ purged: boolean }>(s.send("DELETE", "/api/departments/quality-team", { confirm: "quality-team", purge: true }));
    assert.equal(purged.purged, true);
    assert.ok(!existsSync(join(base.dataDir, "departments", "quality-team")));
    assert.ok(existsSync(join(base.dataDir, "departments", "alpha", "guard.db")), "other departments are untouched");
    assert.equal((await s.get("/api/departments/quality-team")).status, 404);
  } finally {
    await s.stop();
  }
});

test("purging the legacy department over the API is refused", async () => {
  const base = tmpCfg();
  mkdirSync(base.vaultDir, { recursive: true });
  writeFileSync(join(base.vaultDir, "keep.md"), "keep");
  const s = await start(base);
  try {
    assert.equal((await s.send("DELETE", "/api/departments/default", { confirm: "default", purge: true })).status, 400);
    assert.ok(existsSync(join(base.vaultDir, "keep.md")));
    const rr = await s.send("DELETE", "/api/departments/default", { confirm: "default" }); assert.equal(rr.status, 200, rr.body);
    assert.ok(existsSync(join(base.vaultDir, "keep.md")));
  } finally {
    await s.stop();
  }
});

/* ---------------- MCP and CLI ---------------- */

test("MCP: QSB_DEPT picks the department and wins over AURA_GUARD_DEPT", () => {
  const { base } = twoDepartments();
  assert.equal(mcpConfig(base, {}).departmentId, "default", "registry default");
  assert.equal(mcpConfig(base, { AURA_GUARD_DEPT: "beta" }).departmentId, "beta");
  assert.equal(mcpConfig(base, { QSB_DEPT: "alpha", AURA_GUARD_DEPT: "beta" }).departmentId, "alpha");
  assert.equal(mcpConfig(base, { QSB_DEPT: "beta" }).vaultDir, join(base.dataDir, "departments", "beta", "vault"));
  assert.throws(() => mcpConfig(base, { QSB_DEPT: "nope" }), /no department/);
});

function cli(root: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN, ...args], {
      encoding: "utf8", env: { ...process.env, QSB_ROOT: root, QSB_DEPT: "", AURA_GUARD_DEPT: "", ...env }, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
    });
    return { code: 0, out };
  } catch (e) {
    const x = e as { status?: number; stdout?: string; stderr?: string };
    return { code: x.status ?? 1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

test("CLI: --dept selects the department for a command, dept subcommands manage the registry, index --all loops", () => {
  const root = tmpDir("qsb-root-");
  writeFileSync(join(root, "guard.config.local.json"), JSON.stringify({ department: "dev", dataDir: "data", vaultDir: "vault", repos: [], busyProcesses: [] }));
  mkdirSync(join(root, "vault"), { recursive: true });
  const docsA = docsFolder({ "a.md": "# A\nalpha words" });
  const docsB = docsFolder({ "b.md": "# B\nbeta words", "c.md": "# C" });

  assert.match(cli(root, ["dept", "list"]).out, /default/);
  assert.equal(cli(root, ["dept", "add", "alpha", "--name", "Alpha Team", "--template", "knowledge"]).code, 0);
  assert.equal(cli(root, ["dept", "add", "beta", "--name", "Beta Team", "--template", "knowledge"]).code, 0);
  assert.notEqual(cli(root, ["dept", "add", "beta", "--name", "Again"]).code, 0, "duplicate id");
  assert.notEqual(cli(root, ["dept", "add", "Bad Id", "--name", "x"]).code, 0);
  assert.equal(cli(root, ["dept", "module", "add", "alpha", "Docs Module"]).code, 0);
  assert.equal(cli(root, ["dept", "sub", "add", "alpha", "Docs Module", "Inner"]).code, 0);
  assert.equal(cli(root, ["dept", "source", "add", "alpha", "--path", docsA, "--module", "Docs Module", "--sub", "Inner", "--label", "Alpha docs"]).code, 0);
  assert.equal(cli(root, ["dept", "source", "add", "beta", "--path", docsB, "--kind", "docs"]).code, 0);
  assert.notEqual(cli(root, ["dept", "source", "add", "beta", "--path", join(docsB, "nope")]).code, 0, "missing folder");
  assert.notEqual(cli(root, ["dept", "source", "add", "beta", "--path", "\\\\host\\share"]).code, 0, "UNC");
  assert.notEqual(cli(root, ["dept", "source", "add", "beta", "--path", docsB, "--kind", "git"]).code, 0, "not a repo");
  const show = cli(root, ["dept", "show", "alpha"]).out;
  assert.match(show, /Sub-module: Inner/);
  assert.match(show, /Alpha docs/);

  // --dept on a normal command
  const ia = cli(root, ["index", "--dept", "alpha", "--force"]);
  assert.equal(ia.code, 0, ia.out);
  assert.match(ia.out, /Department: Alpha Team/);
  assert.ok(existsSync(join(root, "data", "departments", "alpha", "guard.db")));
  assert.ok(!existsSync(join(root, "data", "departments", "beta", "guard.db")), "beta was not indexed");
  assert.match(cli(root, ["status", "--dept", "alpha"]).out, /file: 1/);
  assert.match(cli(root, ["ask", "alpha", "words", "--dept", "alpha"]).out, /alpha-docs:a\.md/);
  assert.match(cli(root, ["ask", "alpha", "--dept", "beta"]).out, /No index|not built|index/i, "beta has no index yet");
  // the environment variable picks the department too, and QSB_DEPT wins
  assert.match(cli(root, ["status"], { AURA_GUARD_DEPT: "alpha" }).out, /Department: Alpha Team/);
  assert.match(cli(root, ["index", "--force"], { QSB_DEPT: "beta", AURA_GUARD_DEPT: "alpha" }).out, /Department: Beta Team/);
  assert.notEqual(cli(root, ["status", "--dept", "nope"]).code, 0);

  // index --all: every department in turn
  const all = cli(root, ["index", "--all", "--force"]);
  assert.equal(all.code, 0, all.out);
  assert.match(all.out, /== Alpha Team \(alpha\) ==/);
  assert.match(all.out, /== Beta Team \(beta\) ==/);
  assert.match(cli(root, ["status", "--dept", "beta"]).out, /file: 2/);

  // archive, then purge needs --yes and never touches the other department
  assert.equal(cli(root, ["dept", "archive", "beta"]).code, 0);
  assert.notEqual(cli(root, ["index", "--dept", "beta", "--force"]).code, 0, "archived departments are not indexed");
  assert.ok(!/== Beta Team/.test(cli(root, ["index", "--all", "--force"]).out), "index --all skips archived");
  assert.notEqual(cli(root, ["dept", "purge", "beta"]).code, 0, "needs --yes");
  assert.equal(cli(root, ["dept", "purge", "beta", "--yes"]).code, 0);
  assert.ok(!existsSync(join(root, "data", "departments", "beta")));
  assert.ok(existsSync(join(root, "data", "departments", "alpha", "guard.db")));
  assert.ok(existsSync(join(root, "vault")), "the legacy vault is untouched");

  // seed refuses to change a registry that already has departments
  assert.match(cli(root, ["dept", "seed"]).out, /already has departments/);
});

test("seed: reads the local seed file; without one it says where to put it; bad files are refused plainly", () => {
  const base = tmpCfg();
  const none = seedDepartments(base);
  assert.equal(none.noSeedFile, seedFilePath(base));
  assert.deepEqual(none.report, []);
  assert.equal(loadRegistry(base).synthesized, true, "nothing was written without a seed file");
  mkdirSync(join(base.dataDir, "departments"), { recursive: true });
  writeFileSync(seedFilePath(base), "{ not json");
  assert.throws(() => loadSeedFile(base), /not valid JSON/);
  writeFileSync(seedFilePath(base), JSON.stringify({ departments: [{ id: "x", name: "X" }] }));
  assert.throws(() => loadSeedFile(base), /needs id, name, template and color/);
  writeFileSync(seedFilePath(base), JSON.stringify({ departments: [{ id: "xy", name: "XY", template: "custom", color: "teal" }] }));
  assert.equal(seedDepartments(base).report[0]!.id, "xy");
});
