// A small stand-in for the department API, used to develop and screenshot the UI before the real
// engine answers. In-memory data only. It serves ui/ files and the few existing endpoints the app
// calls on boot. Run: node --experimental-strip-types engine/test/ui-stub-server.ts [port] [empty]
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const uiDir = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "ui");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const ROLES_ON = (on: string[]): Json => Object.fromEntries(["scribe", "reviewer", "refactor", "qa", "rules", "prs", "supportWriter", "quiz", "daily"].map((k) => [k, on.includes(k)]));
const TEMPLATES = [
  { id: "engineering", name: "Engineering", description: "A team that writes code in git repositories.", hint: "Add repositories as sources. Reviews, QA plans and rules are on.", roles: ROLES_ON(["scribe", "reviewer", "refactor", "qa", "rules", "prs", "quiz", "daily"]) },
  { id: "knowledge", name: "Knowledge", description: "A team that keeps documents, not code.", hint: "Add document folders as sources. Only notes and questions are on.", roles: ROLES_ON(["scribe", "rules", "quiz", "daily"]) },
  { id: "support", name: "Support", description: "A team that answers customers.", hint: "Add help documents. The support writer is on.", roles: ROLES_ON(["scribe", "supportWriter", "quiz", "daily"]) },
  { id: "analysis", name: "Analysis", description: "A team that studies requirements and data.", hint: "Add document folders and repositories. Rules and QA plans are on.", roles: ROLES_ON(["scribe", "qa", "rules", "quiz", "daily"]) },
  { id: "custom", name: "Custom", description: "Start empty and choose everything yourself.", hint: "Every role is off until you turn it on.", roles: ROLES_ON([]) },
];

const iso = (daysAgo: number): string => new Date(Date.now() - daysAgo * 86400000).toISOString();
const src = (id: string, label: string, path: string, kind = "git"): Json => ({ id, kind, label, path, ...(kind === "git" ? { branch: "main" } : {}) });

export function seedDepartments(): Json[] {
  const mk = (id: string, name: string, description: string, owner: string, template: string, color: string, modules: Json[], sources: Json[], health: Json): Json => ({ id, name, description, owner, template, color, roles: TEMPLATES.find((t) => t.id === template)!.roles, modules, sources, _health: health });
  return [
    mk("product-engineering", "Product Engineering", "Builds and runs the Orders App project.", "Alex", "engineering", "violet", [{ id: "orders-app", name: "Orders App", subModules: [], sources: [src("orders-app-repo", "orders-app", "D:\\Repos\\orders-app")] }], [], { indexedAt: iso(1), commits: 812, files: 2140, notes: 64, active: 51, proposed: 13, inbox: 13, stale: 2, lastDaily: iso(0), reviews: 9, qaPlans: 4, problems: 0 }),
    mk("manufacturing", "Manufacturing", "Cutting optimisation and its services.", "Sam", "engineering", "green", [{ id: "cutting", name: "Cutting", description: "The Cutting module.", subModules: [{ id: "cut-planner", name: "Cut Planner", sources: [src("cut-planner-repo", "cut-planner", "D:\\Repos\\cut-planner")] }, { id: "cut-core", name: "Cut Core", sources: [src("cut-core-repo", "cut-core", "D:\\Repos\\cut-core")] }, { id: "cut-service", name: "Cut Service", sources: [src("cut-service-repo", "cut-service", "D:\\Repos\\cut-service")] }], sources: [] }], [], { indexedAt: iso(12), commits: 1204, files: 3320, notes: 40, active: 30, proposed: 10, inbox: 0, stale: 5, lastDaily: iso(3), reviews: 3, qaPlans: 1, problems: 2 }),
    mk("display-systems", "Display Systems", "Cutting-list optimiser and the wall board.", "Sam", "engineering", "orange", [{ id: "wall-board", name: "Wall Board", subModules: [], sources: [src("wall-board-repo", "wall-board", "D:\\Repos\\wall-board")] }, { id: "optimiser", name: "Optimiser", subModules: [], sources: [src("optimiser-repo", "optimiser", "D:\\Repos\\optimiser")] }], [], { indexedAt: null, commits: 0, files: 0, notes: 0, active: 0, proposed: 0, inbox: 0, stale: 0, lastDaily: null, reviews: 0, qaPlans: 0, problems: 0 }),
    mk("back-office", "Back Office", "Order records and their connectors.", "Alex", "engineering", "blue", [{ id: "records", name: "Order Records", subModules: [], sources: [src("records-repo", "order-records", "D:\\Repos\\order-records")] }], [], { indexedAt: iso(2), commits: 5400, files: 9100, notes: 120, active: 100, proposed: 20, inbox: 4, stale: 8, lastDaily: iso(1), reviews: 22, qaPlans: 11, problems: 1 }),
    mk("ba", "BA", "Business analysis: requirements and flows.", "Ayesha", "analysis", "teal", [], [src("ba-docs", "requirements", "D:\\Docs\\requirements", "docs")], { indexedAt: iso(4), commits: 0, files: 210, notes: 18, active: 18, proposed: 0, inbox: 0, stale: 0, lastDaily: iso(1), reviews: 0, qaPlans: 2, problems: 0 }),
    mk("support", "Support", "Customer support answers.", "Kamal", "support", "rose", [], [], { indexedAt: null, commits: 0, files: 0, notes: 0, active: 0, proposed: 0, inbox: 0, stale: 0, lastDaily: null, reviews: 0, qaPlans: 0, problems: 0 }),
  ];
}

export interface StubHandle { server: Server; url: string; depts: Json[]; close: () => Promise<void> }

export function startStub(opts: { port?: number; empty?: boolean; many?: number } = {}): Promise<StubHandle> {
  let depts: Json[] = opts.empty ? [] : seedDepartments();
  if (opts.many) for (let i = 0; i < opts.many; i++) depts.push({ ...seedDepartments()[i % 6]!, id: `extra-${i}`, name: `Department ${i + 7}` });
  const ver = new Map<string, number>();
  const etag = (id: string): string => `v${ver.get(id) ?? 1}`;
  const listEtag = (): string => depts.map((d) => d.id + etag(d.id)).join(",");
  const view = (d: Json): Json => {
    const { _health, ...rest } = d;
    const all = [...d.sources, ...d.modules.flatMap((m: Json) => [...m.sources, ...m.subModules.flatMap((s: Json) => s.sources)])];
    const h = { indexedAt: null, commits: 0, files: 0, notes: 0, active: 0, proposed: 0, inbox: 0, stale: 0, lastDaily: null, reviews: 0, qaPlans: 0, problems: 0, ..._health, needsSources: all.length === 0 };
    return { ...rest, counts: { modules: d.modules.length, subModules: d.modules.reduce((n: number, m: Json) => n + m.subModules.length, 0), sources: all.length }, health: h };
  };
  const status = (p: string): Json => (/^D:\\Repos\\/i.test(p) || /^D:\\Docs\\/i.test(p) ? { exists: true, isGit: /Repos/.test(p), branch: "main", lastCommitAt: iso(2), docFiles: 14 } : { exists: false, isGit: false, error: "That folder was not found." });
  const mockCmd = (): string[] => ["Reading commits...", "Indexing 812 commits", "Indexing 2140 files", "Index built."];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const send = (code: number, body: unknown): void => {
      const s = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(s);
    };
    let body: Json = {};
    if (method !== "GET") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json; } catch { body = {}; }
    }
    const p = url.pathname;
    if (!p.startsWith("/api/")) {
      const file = p === "/" ? "index.html" : p.slice(1);
      try {
        const data = readFileSync(join(uiDir, file));
        res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
        return void res.end(data);
      } catch {
        res.writeHead(404);
        return void res.end();
      }
    }
    if (p === "/api/departments" && method === "GET") return send(200, { productName: "SPIL Quality Support Bot", defaultDepartment: depts[0]?.id ?? null, etag: listEtag(), departments: depts.map(view), templates: TEMPLATES });
    if (p === "/api/departments" && method === "POST") {
      const name = String(body["name"] ?? "").trim();
      if (!name) return send(400, { error: "A department needs a name." });
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "department";
      if (depts.some((d) => d.id === id)) return send(409, { error: `A department with the id "${id}" already exists.` });
      const d: Json = { id, name, description: body["description"] ?? "", owner: body["owner"] ?? "", template: body["template"] ?? "custom", color: body["color"] ?? "blue", roles: body["roles"] ?? ROLES_ON([]), modules: body["modules"] ?? [], sources: body["sources"] ?? [], _health: {} };
      depts.push(d);
      return send(201, { department: view(d), etag: etag(id) });
    }
    const m = /^\/api\/departments\/([^/]+)(\/sources\/check)?$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[1]!);
      const d = depts.find((x) => x.id === id);
      if (!d) return send(404, { error: `There is no department "${id}".` });
      if (m[2] && method === "POST") return send(200, status(String(body["path"] ?? "")));
      if (method === "GET") {
        const v = view(d);
        const all: Json[] = [];
        for (const s of d.sources) all.push({ ...s, status: status(s.path) });
        for (const mod of d.modules) {
          for (const s of mod.sources) all.push({ ...s, module: mod.id, status: status(s.path) });
          for (const sub of mod.subModules) for (const s of sub.sources) all.push({ ...s, module: mod.id, sub: sub.id, status: status(s.path) });
        }
        return send(200, { department: v, etag: etag(id), health: v["health"], sources: all });
      }
      if (method === "PUT") {
        if (body["etag"] !== etag(id)) return send(409, { error: "This department changed since you loaded it. Reload and try again." });
        const next = body["department"] as Json;
        if (!next || !String(next["name"] ?? "").trim()) return send(400, { error: "A department needs a name." });
        Object.assign(d, { name: next["name"], description: next["description"], owner: next["owner"], color: next["color"], roles: next["roles"], modules: next["modules"], sources: next["sources"] });
        ver.set(id, (ver.get(id) ?? 1) + 1);
        return send(200, { department: view(d), etag: etag(id) });
      }
      if (method === "DELETE") {
        if (body["confirm"] !== id) return send(400, { error: "Type the department id to confirm." });
        if (body["purge"]) depts = depts.filter((x) => x.id !== id);
        else d.archived = true;
        return send(200, { ok: true });
      }
    }
    if (p === "/api/status") return send(200, { index: { note: 64, commit: 812, file: 2140 }, vault: { notes: 64, problems: 0 }, backend: { wanted: "auto", picked: "claude-cli", label: "Claude plan" }, running: null });
    if (p === "/api/commands") return send(200, { commands: [{ name: "index", available: true, description: "Rebuild the index" }] });
    if (p === "/api/chats" && method === "GET") return send(200, { chats: [] });
    if (p === "/api/chats" && method === "POST") return send(201, { id: "c" + "0".repeat(11), title: "New chat", updated: new Date().toISOString(), messages: [] });
    if (p === "/api/inbox") return send(200, { total: 0, groups: [] });
    if (p === "/api/reports") return send(200, { reports: [] });
    if (p === "/api/command" && method === "POST") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
      res.write(JSON.stringify({ type: "started", command: "/index" }) + "\n");
      for (const line of mockCmd()) {
        await new Promise((r) => setTimeout(r, 120));
        res.write(JSON.stringify({ type: "output", chunk: line + "\n" }) + "\n");
      }
      res.write(JSON.stringify({ type: "done", ok: true, code: 0, command: "/index", chat: null }) + "\n");
      return void res.end();
    }
    send(404, { error: "Not found." });
  });
  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, depts, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const h = await startStub({ port: Number(process.argv[2] ?? 4700), empty: process.argv[3] === "empty", many: process.argv[3] === "many" ? 24 : 0 });
  console.log(h.url);
}
