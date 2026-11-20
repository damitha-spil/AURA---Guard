import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthBlockedError, createClient, getChangedFiles, getThreads, listPullRequests } from "../src/prs/azure.ts";
import type { RepoCtx } from "../src/prs/remote.ts";
import { parseRemote } from "../src/prs/remote.ts";
import { loadSalt, personHash } from "../src/prs/privacy.ts";
import { loadStoredPrs, syncPrs } from "../src/prs/store.ts";
import { findCandidates, minePrs, scoreText } from "../src/prs/mine.ts";
import { buildDataset, writeDataset } from "../src/prs/dataset.ts";
import { splitFrontmatter } from "../src/vault/frontmatter.ts";
import { validateMeta } from "../src/vault/schema.ts";
import type { GuardConfig } from "../src/types.ts";

// Built at runtime so no secret-shaped literal sits in this file.
const FAKE_PASSWORD = "pw" + "-" + "Zq8" + "rT5mK2" + "vXw9L";
const FAKE_AWS = "AK" + "IA" + "Q7ZXN4MPLW2RTV6B";
const AUTHOR = { id: "id-author-1", displayName: "Jane Quill", uniqueName: "jane.quill@example.test" };
const REVIEWER = { id: "id-rev-2", displayName: "Bob Marlowe", uniqueName: "bob.marlowe@example.test" };
const BASIC = "Basic " + Buffer.from("user:" + FAKE_PASSWORD).toString("base64");

function comment(id: number, who: typeof AUTHOR, content: string, type = "text", parent = 0) {
  return { id, parentCommentId: parent, author: who, content, publishedDate: "2026-01-05T10:00:00Z", commentType: type };
}

function threads(prId: number) {
  const sys = {
    id: 1,
    comments: [comment(1, { id: "svc", displayName: "Service", uniqueName: "svc", isContainer: true } as typeof AUTHOR, "Policy status", "system")],
    properties: { CodeReviewThreadType: { $value: "VoteUpdate" } },
    threadContext: null,
  };
  const fixed = {
    id: 2,
    status: "fixed",
    threadContext: { filePath: "/src/orders/save.rs", rightFileStart: { line: 12, offset: 1 } },
    comments: [
      comment(1, REVIEWER, "Please don't swallow this error, use a typed error instead. Jane Quill, ask bob.marlowe@example.test if unsure."),
      comment(2, AUTHOR, "Fixed, thanks", "text", 1),
    ],
  };
  const wont = {
    id: 3,
    status: "wontFix",
    threadContext: { filePath: "/src/orders/save.rs", rightFileStart: { line: 40 } },
    comments: [comment(1, REVIEWER, "Please don't swallow this error, use a typed error instead.")],
  };
  const secret = {
    id: 4,
    status: "active",
    threadContext: { filePath: "/docs/a.md", rightFileStart: { line: 1 } },
    comments: [comment(1, REVIEWER, `You should remove this key ${FAKE_AWS} from the file`)],
  };
  const chatter = { id: 5, status: "active", threadContext: null, comments: [comment(1, REVIEWER, "lgtm")] };
  const deleted = { id: 6, status: "active", isDeleted: true, comments: [comment(1, REVIEWER, "should be removed please")] };
  void prId;
  return [sys, fixed, wont, secret, chatter, deleted];
}

interface Seen {
  methods: string[];
  urls: string[];
}

function startServer(total: number, seen: Seen, opts: { reject?: boolean } = {}): Promise<{ server: Server; ctx: RepoCtx }> {
  const server = createServer((req, res) => {
    seen.methods.push(req.method ?? "");
    seen.urls.push(req.url ?? "");
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (opts.reject || req.headers.authorization !== BASIC) return send(401, { message: "nope" });
    const u = new URL(req.url ?? "/", "http://x");
    const base = "/proj/_apis/git/repositories/repo";
    if (u.searchParams.get("api-version") !== "7.1") return send(400, {});
    if (u.pathname === `${base}/pullrequests`) {
      const top = Number(u.searchParams.get("$top"));
      const skip = Number(u.searchParams.get("$skip") ?? 0);
      const value = [];
      for (let i = skip; i < Math.min(total, skip + top); i++) {
        const id = total - i; // newest first
        value.push({
          pullRequestId: id,
          title: `Change ${id} for Jane Quill`,
          status: "completed",
          createdBy: AUTHOR,
          creationDate: "2026-01-01T00:00:00Z",
          closedDate: "2026-01-06T00:00:00Z",
          sourceRefName: "refs/heads/feature/x",
          targetRefName: "refs/heads/development",
          lastMergeCommit: { commitId: "c".repeat(40) },
          lastMergeSourceCommit: { commitId: "d".repeat(40) },
        });
      }
      return send(200, { value, count: value.length });
    }
    const m = /^\/proj\/_apis\/git\/repositories\/repo\/pullRequests\/(\d+)\/(threads|iterations)(?:\/(\d+)\/changes)?$/.exec(u.pathname);
    if (m) {
      if (m[2] === "threads") return send(200, { value: threads(Number(m[1])), count: 6 });
      if (m[3]) {
        const skip = Number(u.searchParams.get("$skip") ?? 0);
        const all = ["/src/a.ts", "/src/b.ts", "/src/c.ts"];
        const top = Number(u.searchParams.get("$top"));
        const slice = all.slice(skip, skip + top);
        const next = skip + top < all.length ? skip + top : 0;
        return send(200, { changeEntries: slice.map((p) => ({ item: { path: p }, changeType: "edit" })), nextSkip: next, nextTop: next ? top : 0 });
      }
      return send(200, { value: [{ id: 1 }, { id: 2 }], count: 2 });
    }
    send(404, {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, ctx: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, projectPath: "/proj", project: "proj", repo: "repo" } });
    });
  });
}

const creds = async () => ({ username: "user", password: FAKE_PASSWORD });

function tmpCfg(): GuardConfig {
  const root = mkdtempSync(join(tmpdir(), "guard-prs-"));
  return { department: "dev", dataDir: join(root, "data"), vaultDir: join(root, "vault"), repos: [], busyProcesses: [], root };
}

function allFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...allFiles(p));
    else out.push(p);
  }
  return out;
}

test("remote parsing: both styles, encoded names", () => {
  const a = parseRemote("https://acme.visualstudio.com/My%20Proj/_git/My%20Repo");
  assert.equal(a?.host, "acme.visualstudio.com");
  assert.equal(a?.project, "My Proj");
  assert.equal(a?.repo, "My Repo");
  assert.equal(a?.projectPath, "/My%20Proj");
  const b = parseRemote("https://dev.azure.com/acme/My%20Proj/_git/My%20Repo");
  assert.equal(b?.org, "acme");
  assert.equal(b?.project, "My Proj");
  assert.equal(b?.projectPath, "/acme/My%20Proj");
  const c = parseRemote("https://acme@dev.azure.com/acme/P/_git/R");
  assert.equal(c?.host, "dev.azure.com");
  assert.equal(parseRemote("https://example.test/nothing"), undefined);
  assert.equal(parseRemote("not a url"), undefined);
});

test("paging, only GET, and nothing but the header carries the credential", async () => {
  const seen: Seen = { methods: [], urls: [] };
  const { server, ctx } = await startServer(130, seen);
  try {
    const c = createClient(ctx, { credentials: creds });
    const prs = await listPullRequests(c, { top: 130 });
    assert.equal(prs.length, 130);
    assert.equal(new Set(prs.map((p) => p.pullRequestId)).size, 130);
    assert.equal((await listPullRequests(c, { top: 5 })).length, 5);
    assert.equal((await getThreads(c, 7)).length, 6);
    const f = await getChangedFiles(c, 7, 2);
    assert.deepEqual(f, { files: ["src/a.ts", "src/b.ts"], truncated: true });
    assert.deepEqual(await getChangedFiles(c, 7), { files: ["src/a.ts", "src/b.ts", "src/c.ts"], truncated: false });
    assert.ok(seen.methods.length > 5);
    assert.ok(seen.methods.every((m) => m === "GET"));
    assert.ok(seen.urls.every((u) => !u.includes(FAKE_PASSWORD) && !u.includes(Buffer.from("user:" + FAKE_PASSWORD).toString("base64"))));
  } finally {
    server.close();
  }
});

test("401 gives a plain blocker without the secret; no credential is also a blocker", async () => {
  const seen: Seen = { methods: [], urls: [] };
  const { server, ctx } = await startServer(1, seen, { reject: true });
  try {
    await assert.rejects(
      () => createClient(ctx, { credentials: creds }).probe(),
      (e: Error) => e instanceof AuthBlockedError && e.message.includes("401") && !e.message.includes(FAKE_PASSWORD),
    );
    await assert.rejects(() => createClient(ctx, { credentials: async () => undefined }).probe(), AuthBlockedError);
    assert.equal(seen.methods.length, 1); // the missing credential made no request
  } finally {
    server.close();
  }
});

test("a non-HTTPS non-local address never receives the sign-in", () => {
  const ctx: RepoCtx = { origin: "http://example.test", host: "example.test", projectPath: "/p", project: "p", repo: "r" };
  assert.throws(() => createClient(ctx, { credentials: creds }), AuthBlockedError);
});

test("retry once on 500 then succeed", async () => {
  let hits = 0;
  const fake = (async () => {
    hits++;
    return hits === 1 ? new Response("x", { status: 500 }) : new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const ctx: RepoCtx = { origin: "https://h.test", host: "h.test", projectPath: "/p", project: "p", repo: "r" };
  const c = createClient(ctx, { fetch: fake, credentials: creds, sleep: async () => {} });
  assert.deepEqual(await listPullRequests(c, { top: 1 }), []);
  assert.equal(hits, 2);
});

test("a redirect is not followed", async () => {
  const fake = (async () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } })) as typeof fetch;
  const ctx: RepoCtx = { origin: "https://h.test", host: "h.test", projectPath: "/p", project: "p", repo: "r" };
  await assert.rejects(() => createClient(ctx, { fetch: fake, credentials: creds }).probe(), /not followed/);
});

test("person hash is stable per salt, differs per person and per salt", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-salt-"));
  const s1 = loadSalt(dir);
  assert.equal(loadSalt(dir), s1);
  assert.match(personHash(s1, AUTHOR), /^p-[0-9a-f]{6}$/);
  assert.equal(personHash(s1, AUTHOR), personHash(s1, { ...AUTHOR, displayName: "Renamed" }));
  assert.notEqual(personHash(s1, AUTHOR), personHash(s1, REVIEWER));
  assert.notEqual(personHash(s1, AUTHOR), personHash(loadSalt(mkdtempSync(join(tmpdir(), "guard-salt-"))), AUTHOR));
});

async function syncedCfg(): Promise<{ cfg: GuardConfig; seen: Seen }> {
  const seen: Seen = { methods: [], urls: [] };
  const { server, ctx } = await startServer(3, seen);
  const cfg = tmpCfg();
  try {
    const r = await syncPrs(cfg, createClient(ctx, { credentials: creds }), "repo", { limit: 10 });
    assert.equal(r.listed, 3);
    assert.equal(r.fetched, 3);
    assert.equal(r.secretsDropped, 3); // one secret comment per PR
    // Second run: closed PRs unchanged, so nothing is fetched again.
    const again = await syncPrs(cfg, createClient(ctx, { credentials: creds }), "repo", { limit: 10 });
    assert.equal(again.skipped, 3);
    assert.equal(again.fetched, 0);
  } finally {
    server.close();
  }
  return { cfg, seen };
}

test("sync stores masked, person-free data and drops system and secret items", async () => {
  const { cfg, seen } = await syncedCfg();
  assert.ok(seen.methods.every((m) => m === "GET"));
  const prs = loadStoredPrs(cfg, "repo");
  assert.equal(prs.length, 3);
  const pr = prs[0]!;
  assert.deepEqual(pr.files, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(pr.mergeCommit, "c".repeat(40));
  // system thread, secret thread, deleted thread dropped; "lgtm" chatter kept as a comment (filtered later)
  assert.deepEqual(pr.threads.map((t) => t.id), [2, 3, 5]);
  const t2 = pr.threads[0]!;
  assert.equal(t2.file, "src/orders/save.rs");
  assert.equal(t2.line, 12);
  assert.equal(t2.comments[0]?.isAuthor, false);
  assert.equal(t2.comments[1]?.isAuthor, true);
  assert.match(t2.comments[0]!.person, /^p-[0-9a-f]{6}$/);
  // Scan every stored file for the credential, secret and any person detail.
  for (const f of allFiles(join(cfg.dataDir, "prs"))) {
    if (f.endsWith(".salt")) continue;
    const text = readFileSync(f, "utf8");
    for (const bad of [FAKE_PASSWORD, FAKE_AWS, "Jane", "Quill", "Marlowe", "bob.marlowe", "example.test", "id-author-1", "id-rev-2", BASIC]) {
      assert.ok(!text.includes(bad), `${f} leaks ${bad}`);
    }
  }
});

test("mining scores accepted above rejected, notes validate, rerun dedupes", async () => {
  const { cfg } = await syncedCfg();
  const prs = loadStoredPrs(cfg, "repo");
  const cands = findCandidates("repo", prs);
  const accepted = cands.find((c) => c.thread === 2 && c.pr === prs[0]!.id)!;
  const disputed = cands.find((c) => c.thread === 3 && c.pr === prs[0]!.id)!;
  assert.equal(accepted.outcome, "accepted");
  assert.equal(disputed.outcome, "disputed");
  assert.ok(accepted.score > disputed.score);
  assert.ok(!cands.some((c) => c.thread === 5)); // praise only
  assert.equal(scoreText("lgtm"), undefined);

  const dry = minePrs(cfg, "repo", { dryRun: true });
  assert.equal(dry.written.length, 0);
  assert.ok(dry.areas[0]?.area.startsWith("src/orders"));

  const w = minePrs(cfg, "repo", { minScore: 0.9 });
  assert.equal(w.written.length, 3); // thread 2 in each of the 3 PRs
  for (const file of w.written) {
    const text = readFileSync(file, "utf8");
    const sp = splitFrontmatter(text);
    const v = validateMeta(sp.data, file);
    assert.equal(v.problems.length, 0, JSON.stringify(v.problems));
    assert.equal(v.meta?.source, "pr-comment");
    assert.match(sp.body, /PR review comment on 2026-01-05 \([0-9a-f]{6}\)/);
    assert.match(sp.body, /<!-- pr: \d+ thread: 2 hash: [0-9a-f]+ -->/);
    assert.ok(sp.body.includes("## What the reviewer said") && sp.body.includes("## Outcome") && sp.body.includes("accepted"));
    for (const bad of ["Jane", "Marlowe", "example.test", FAKE_AWS]) assert.ok(!text.includes(bad));
  }
  const again = minePrs(cfg, "repo", { minScore: 0.9 });
  assert.equal(again.written.length, 0);
  assert.equal(again.skippedDuplicate, 3);
});

test("dataset has one line per merged PR with reviewer comments only", async () => {
  const { cfg } = await syncedCfg();
  const lines = buildDataset(cfg, "repo");
  assert.equal(lines.length, 3);
  const l = lines[0]!;
  assert.equal(l.mergeCommit, "c".repeat(40));
  assert.ok(l.comments.some((c) => c.accepted === true) && l.comments.some((c) => c.accepted === false));
  assert.ok(!l.comments.some((c) => c.text === "Fixed, thanks"));
  const w = writeDataset(cfg, "repo");
  const raw = readFileSync(w.file, "utf8").trim().split("\n");
  assert.equal(raw.length, 3);
  assert.equal((JSON.parse(raw[0]!) as { pr: number }).pr, l.pr);
});
