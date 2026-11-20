// Department UI logic: tree edits, validation, health labels, templates, the landing helpers, the
// wizard reducer and the API client (with a hand-written fake fetch). Pure modules, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Dept = { id: string; name: string; description: string; owner: string; template: string; color: string; roles: Record<string, boolean>; modules: Mod[]; sources: Src[]; archived?: boolean; counts?: Record<string, number>; health?: Record<string, unknown>; moduleNames?: string[] };
type Mod = { id: string; name: string; subModules: Sub[]; sources: Src[] };
type Sub = { id: string; name: string; sources: Src[] };
type Src = { id: string; kind: string; label: string; path: string };
type Wiz = { step: number; draft: Dept; rolesTouched: boolean; errors: string[]; dirty: boolean };

interface DeptMod {
  slug(t: string): string;
  uniqueId(t: string, taken: string[]): string;
  allIds(d: Dept): string[];
  emptyDepartment(): Dept;
  addModule(d: Dept, n: string): Dept;
  addSubModule(d: Dept, m: string, n: string): Dept;
  renameNode(d: Dept, id: string, n: string): Dept;
  removeNode(d: Dept, id: string): Dept;
  addSource(d: Dept, t: { moduleId?: string; subId?: string }, s: { kind?: string; path: string; label?: string }): Dept;
  removeSource(d: Dept, id: string): Dept;
  validatePath(p: string): string;
  validateDepartment(d: Dept): string[];
  indexAge(at: string | number | null, now?: number): { state: string; label: string; days: number | null };
  tileHealth(d: Partial<Dept>, now?: number): { tone: string; label: string };
  summarizeAll(l: Partial<Dept>[], now?: number): Record<string, number>;
  templateRoles(id: string, t?: unknown): Record<string, boolean>;
  classifySave(r: { ok?: boolean; status?: number; data?: { error?: string } }): { kind: string; message?: string };
  loadLast(s: unknown): string | null;
  saveLast(s: unknown, id: string): boolean;
  continueTarget(l: Partial<Dept>[], id: string | null): Partial<Dept> | null;
  filterDepartments(l: Partial<Dept>[], q: string): Partial<Dept>[];
  numberKeyTarget(k: string, v: Partial<Dept>[]): Partial<Dept> | null;
  moveIndex(i: number, k: string, n: number, c?: number): number;
  landingMode(l: Partial<Dept>[]): string;
  LAST_KEY: string;
  COLORS: string[];
  colorHex(c: unknown): string;
  isColor(c: unknown): boolean;
  ROLE_KEYS: string[];
}
interface WizMod {
  STEPS: string[];
  initialWizard(t?: unknown): Wiz;
  wizardReducer(s: Wiz, a: Record<string, unknown>): Wiz;
  createBody(s: Wiz): Record<string, unknown>;
}
interface ApiMod {
  createDeptApi(f: unknown): Record<string, (...a: unknown[]) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>>;
  withDept(p: string, b: unknown, d: string | null): { path: string; body: unknown };
}
const uiDir = join(import.meta.dirname, "..", "..", "ui");
const ui = async <T>(f: string): Promise<T> => (await import(pathToFileURL(join(uiDir, f)).href)) as T;
const D = await ui<DeptMod>("departments.js");
const Wz = await ui<WizMod>("wizard.js");
const Api = await ui<ApiMod>("deptapi.js");
const NOW = Date.parse("2026-11-20T12:00:00Z");
const day = (n: number): string => new Date(NOW - n * 86400000).toISOString();

function shape(): Dept {
  let d = D.emptyDepartment();
  d.name = "Manufacturing";
  d = D.addModule(d, "Cutting");
  const m = d.modules[0]!.id;
  for (const n of ["Cut Planner", "Cut Core", "Cut Service"]) d = D.addSubModule(d, m, n);
  return d;
}

test("slug and uniqueId produce safe, distinct ids", () => {
  assert.equal(D.slug("Cut Planner!"), "cut-planner");
  assert.equal(D.slug("  "), "item");
  assert.equal(D.slug("Cafe\u0301 Mod"), "cafe-mod");
  assert.equal(D.uniqueId("Cutting", ["cutting"]), "cutting-2");
  assert.equal(D.uniqueId("Cutting", ["cutting", "cutting-2"]), "cutting-3");
  assert.ok(D.slug("x".repeat(200)).length <= 40);
});

test("tree edits keep ids unique and never change the input", () => {
  const d0 = D.emptyDepartment();
  let d = D.addModule(d0, "Cutting");
  assert.equal(d0.modules.length, 0, "input untouched");
  d = D.addModule(d, "Cutting");
  d = D.addModule(d, "  ");
  assert.deepEqual(d.modules.map((m) => m.id), ["cutting", "cutting-2"]);
  d = D.addSubModule(d, "cutting", "Cutting");
  assert.equal(new Set(D.allIds(d)).size, D.allIds(d).length);
  d = D.addSubModule(d, "missing", "Ghost");
  assert.equal(D.allIds(d).includes("ghost"), false);
});

test("rename keeps the id; remove drops the module with its sub-modules", () => {
  let d = shape();
  d = D.renameNode(d, "cut-core", "Cut Core Library");
  assert.equal(d.modules[0]!.subModules[1]!.id, "cut-core");
  assert.equal(d.modules[0]!.subModules[1]!.name, "Cut Core Library");
  assert.equal(D.renameNode(d, "cut-core", "  ").modules[0]!.subModules[1]!.name, "Cut Core Library");
  assert.equal(D.removeNode(d, "cut-service").modules[0]!.subModules.length, 2);
  assert.equal(D.removeNode(d, "cutting").modules.length, 0);
  // a new module may reuse a removed id
  assert.equal(D.addSubModule(D.removeNode(d, "cut-service"), "cutting", "Cut Service").modules[0]!.subModules[2]!.id, "cut-service");
});

test("sources attach to the department, a module or a sub-module; ids stay unique across kinds", () => {
  let d = shape();
  d = D.addSource(d, {}, { kind: "git", path: "D:\\Repos\\a", label: "Cutting" });
  d = D.addSource(d, { moduleId: "cutting" }, { kind: "docs", path: "D:\\Docs\\b", label: "Cutting" });
  d = D.addSource(d, { moduleId: "cutting", subId: "cut-core" }, { path: "/srv/core" });
  assert.equal(d.sources.length, 1);
  assert.equal(d.modules[0]!.sources[0]!.kind, "docs");
  assert.equal(d.modules[0]!.subModules[1]!.sources[0]!.label, "core");
  const ids = D.allIds(d);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(D.addSource(d, { moduleId: "nope" }, { path: "D:\\x" }).sources.length, 1, "unknown target adds nothing");
  assert.equal(D.removeSource(d, d.modules[0]!.sources[0]!.id).modules[0]!.sources.length, 0);
});

test("path validation accepts local absolute paths only", () => {
  for (const ok of ["D:\\Repos\\aura", "C:/Users/x/repo", "/home/me/repo"]) assert.equal(D.validatePath(ok), "", ok);
  const bad: Record<string, RegExp> = {
    "": /Enter/,
    "\\\\server\\share\\repo": /UNC/,
    "//server/share": /UNC/,
    "https://example.com/repo.git": /web address/,
    "git://host/x": /web address/,
    "repos\\aura": /full path/,
    "./aura": /full path/,
    "D:\\Repos\\..\\secret": /\.\./,
    "/home/../etc": /\.\./,
    "D:Repos": /full path/,
  };
  for (const [p, re] of Object.entries(bad)) assert.match(D.validatePath(p), re, JSON.stringify(p));
});

test("validateDepartment lists plain problems", () => {
  const d = shape();
  assert.deepEqual(D.validateDepartment(d), []);
  assert.match(D.validateDepartment({ ...d, name: " " })[0]!, /name/);
  const dup = JSON.parse(JSON.stringify(d)) as Dept;
  dup.modules[0]!.subModules[0]!.id = "cutting";
  assert.match(D.validateDepartment(dup).join(" "), /"cutting" is used twice/);
  const withBad = D.addSource(d, {}, { path: "relative\\x", label: "Oops" });
  assert.match(D.validateDepartment(withBad).join(" "), /Oops.*full path/);
  assert.match(D.validateDepartment({ ...d, color: "chartreuse" }).join(" "), /colour/);
});

test("health labels: fresh, stale, never", () => {
  assert.equal(D.indexAge(null, NOW).state, "never");
  assert.equal(D.indexAge("garbage", NOW).state, "never");
  assert.deepEqual(D.indexAge(day(0), NOW), { state: "fresh", label: "Indexed today", days: 0 });
  assert.equal(D.indexAge(day(1), NOW).label, "Indexed yesterday");
  assert.equal(D.indexAge(day(7), NOW).state, "fresh");
  assert.equal(D.indexAge(day(8), NOW).state, "stale");
  assert.equal(D.indexAge(day(30), NOW).label, "Indexed 30 days ago");
  const withSrc = { counts: { sources: 2 } };
  assert.deepEqual(D.tileHealth({ counts: { sources: 0 } }, NOW), { tone: "bad", label: "Needs sources" });
  assert.deepEqual(D.tileHealth({ ...withSrc, health: { indexedAt: null } }, NOW), { tone: "warn", label: "Not indexed" });
  assert.deepEqual(D.tileHealth({ ...withSrc, health: { indexedAt: day(20) } }, NOW), { tone: "warn", label: "Stale index" });
  assert.deepEqual(D.tileHealth({ ...withSrc, health: { indexedAt: day(1), inbox: 3 } }, NOW), { tone: "ok", label: "3 in inbox" });
  assert.deepEqual(D.tileHealth({ ...withSrc, health: { indexedAt: day(1), inbox: 0 } }, NOW), { tone: "ok", label: "Fresh" });
  const sum = D.summarizeAll([{ counts: { modules: 1, subModules: 3, sources: 3 }, health: { inbox: 2, problems: 1, indexedAt: day(30) } }, { counts: { modules: 0, subModules: 0, sources: 0 }, health: {} }, { archived: true, counts: { modules: 9 } }], NOW);
  assert.deepEqual(sum, { departments: 2, modules: 1, subModules: 3, sources: 3, inbox: 2, needSources: 1, stale: 1, problems: 1 });
});

test("templates give default roles", () => {
  const eng = D.templateRoles("engineering");
  assert.equal(eng["reviewer"], true);
  assert.equal(eng["supportWriter"], false);
  assert.equal(D.templateRoles("support")["supportWriter"], true);
  assert.equal(Object.values(D.templateRoles("custom")).some(Boolean), false);
  assert.deepEqual(Object.keys(D.templateRoles("knowledge")), D.ROLE_KEYS);
  assert.equal(D.templateRoles("engineering", [{ id: "engineering", roles: { quiz: true } }])["quiz"], true, "server templates win");
  assert.equal(D.templateRoles("engineering", [{ id: "engineering", roles: { quiz: true } }])["reviewer"], false);
  assert.equal(D.templateRoles("engineering", [{ id: "engineering", roles: ["qa"] }])["qa"], true, "role lists work too");
});

test("etag conflicts and errors are told apart", () => {
  assert.deepEqual(D.classifySave({ ok: true, status: 200 }), { kind: "ok" });
  const c = D.classifySave({ ok: false, status: 409, data: { error: "stale" } });
  assert.equal(c.kind, "conflict");
  assert.match(c.message!, /reloaded/);
  assert.deepEqual(D.classifySave({ ok: false, status: 400, data: { error: "Bad name." } }), { kind: "error", message: "Bad name." });
  assert.equal(D.classifySave({ ok: false, status: 0 }).kind, "error");
});

/* ---------- landing ---------- */
const L: Partial<Dept>[] = [
  { id: "product-engineering", name: "Product Engineering", description: "Builds the Orders App project", owner: "Alex", moduleNames: ["Orders App"] },
  { id: "manufacturing", name: "Manufacturing", description: "Cutting optimisation", owner: "Sam", moduleNames: ["Cutting", "Cut Planner"] },
  { id: "back-office", name: "Back Office", description: "Order Records", owner: "Alex" },
  { id: "old", name: "Old", archived: true },
];
class Store { m = new Map<string, string>(); getItem(k: string): string | null { return this.m.get(k) ?? null; } setItem(k: string, v: string): void { this.m.set(k, v); } }
const Throwing = { getItem(): string { throw new Error("blocked"); }, setItem(): void { throw new Error("blocked"); } };

test("landing filter narrows by name, id, description, owner and module; ignores archived", () => {
  assert.equal(D.filterDepartments(L, "").length, 3);
  assert.deepEqual(D.filterDepartments(L, "manu").map((d) => d.id), ["manufacturing"]);
  assert.deepEqual(D.filterDepartments(L, "ALEX").map((d) => d.id), ["product-engineering", "back-office"]);
  assert.deepEqual(D.filterDepartments(L, "alex back").map((d) => d.id), ["back-office"]);
  assert.deepEqual(D.filterDepartments(L, "manufacturing cut planner").map((d) => d.id), ["manufacturing"], "module names count");
  assert.deepEqual(D.filterDepartments(L, "old"), []);
  assert.deepEqual(D.filterDepartments(L, "zzz"), []);
});

test("number keys 1-9 map to the first nine visible tiles", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, name: `D${i}` }));
  assert.equal(D.numberKeyTarget("1", many)!.id, "d0");
  assert.equal(D.numberKeyTarget("9", many)!.id, "d8");
  assert.equal(D.numberKeyTarget("0", many), null);
  assert.equal(D.numberKeyTarget("a", many), null);
  assert.equal(D.numberKeyTarget("12", many), null);
  assert.equal(D.numberKeyTarget("5", many.slice(0, 2)), null);
  assert.equal(D.numberKeyTarget("2", D.filterDepartments(L, "ale"))!.id, "back-office", "numbers follow the filter");
});

test("arrow movement stays inside the grid", () => {
  assert.equal(D.moveIndex(0, "ArrowRight", 5, 3), 1);
  assert.equal(D.moveIndex(1, "ArrowDown", 5, 3), 4);
  assert.equal(D.moveIndex(4, "ArrowDown", 5, 3), 4);
  assert.equal(D.moveIndex(1, "ArrowUp", 5, 3), 0);
  assert.equal(D.moveIndex(0, "ArrowLeft", 5, 3), 0);
  assert.equal(D.moveIndex(2, "End", 5, 3), 4);
  assert.equal(D.moveIndex(-1, "ArrowDown", 5, 1), 1);
  assert.equal(D.moveIndex(0, "ArrowDown", 0, 1), -1);
});

test("the last-department shortcut survives storage that throws", () => {
  const s = new Store();
  assert.equal(D.loadLast(s), null);
  assert.equal(D.saveLast(s, "manufacturing"), true);
  assert.equal(s.getItem(D.LAST_KEY), "manufacturing");
  assert.equal(D.loadLast(s), "manufacturing");
  assert.equal(D.loadLast(Throwing), null);
  assert.equal(D.saveLast(Throwing, "x"), false);
  assert.equal(D.loadLast(null), null);
  assert.equal(D.continueTarget(L, "manufacturing")!.id, "manufacturing");
  assert.equal(D.continueTarget(L, "old"), null, "archived is not offered");
  assert.equal(D.continueTarget(L, "gone"), null);
  assert.equal(D.continueTarget(L, null), null);
});

test("landing mode for 0, 1 and many departments", () => {
  assert.equal(D.landingMode([]), "empty");
  assert.equal(D.landingMode([{ id: "a", archived: true }]), "empty");
  assert.equal(D.landingMode([{ id: "a" }]), "one");
  assert.equal(D.landingMode(L), "many");
  assert.equal(D.filterDepartments(Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, name: `Dept ${i}` })), "dept 3").length, 13);
});

/* ---------- wizard ---------- */
test("wizard: basics need a name; next and back keep what was typed", () => {
  let w = Wz.initialWizard();
  assert.equal(w.step, 0);
  w = Wz.wizardReducer(w, { type: "next" });
  assert.equal(w.step, 0);
  assert.match(w.errors[0]!, /name/);
  w = Wz.wizardReducer(w, { type: "set", field: "name", value: "Manufacturing" });
  assert.deepEqual(w.errors, []);
  w = Wz.wizardReducer(w, { type: "next" });
  assert.equal(w.step, 1);
  w = Wz.wizardReducer(w, { type: "addModule", name: "Cutting" });
  w = Wz.wizardReducer(w, { type: "addSubModule", moduleId: "cutting", name: "Cut Core" });
  w = Wz.wizardReducer(w, { type: "back" });
  assert.equal(w.draft.name, "Manufacturing");
  w = Wz.wizardReducer(w, { type: "next" });
  assert.equal(w.draft.modules[0]!.subModules[0]!.name, "Cut Core");
  assert.equal(w.dirty, true);
  w = Wz.wizardReducer(w, { type: "back" });
  w = Wz.wizardReducer(w, { type: "back" });
  w = Wz.wizardReducer(w, { type: "back" });
  assert.equal(w.step, 0, "back stops at the first step");
});

test("wizard: sources may be skipped, bad paths block, template roles follow until touched", () => {
  let w = Wz.initialWizard();
  w = Wz.wizardReducer(w, { type: "set", field: "name", value: "Docs team" });
  w = Wz.wizardReducer(w, { type: "template", id: "support" });
  assert.equal(w.draft.roles["supportWriter"], true);
  w = Wz.wizardReducer(w, { type: "goto", step: 2 });
  assert.equal(w.step, 2);
  w = Wz.wizardReducer(w, { type: "next" });
  assert.equal(w.step, 3, "skipping sources is allowed");
  w = Wz.wizardReducer(w, { type: "role", key: "quiz", value: false });
  w = Wz.wizardReducer(w, { type: "template", id: "engineering" });
  assert.equal(w.draft.roles["quiz"], false, "a role the user chose is kept");
  assert.equal(w.draft.roles["reviewer"], false, "template change does not overwrite touched roles");
  w = Wz.wizardReducer(w, { type: "resetRoles" });
  assert.equal(w.draft.roles["reviewer"], true);
  assert.equal(w.rolesTouched, false);
  let b = Wz.wizardReducer(Wz.wizardReducer(Wz.initialWizard(), { type: "set", field: "name", value: "X" }), { type: "addSource", target: {}, source: { kind: "git", path: "..\\x" } });
  b = Wz.wizardReducer(b, { type: "goto", step: 2 });
  b = Wz.wizardReducer(b, { type: "next" });
  assert.equal(b.step, 2);
  assert.match(b.errors[0]!, /full path|\.\./);
});

test("wizard: jumping forward is checked, createBody is trimmed", () => {
  let w = Wz.initialWizard();
  w = Wz.wizardReducer(w, { type: "goto", step: 4 });
  assert.equal(w.step, 0, "cannot jump past an invalid step");
  w = Wz.wizardReducer(w, { type: "set", field: "name", value: "  ERP  " });
  w = Wz.wizardReducer(w, { type: "set", field: "owner", value: " Alex " });
  w = Wz.wizardReducer(w, { type: "goto", step: 4 });
  assert.equal(w.step, 4);
  assert.deepEqual(Wz.wizardReducer(w, { type: "goto", step: 99 }).step, 4);
  const body = Wz.createBody(w);
  assert.equal(body["name"], "ERP");
  assert.equal(body["owner"], "Alex");
  assert.equal("description" in body, false);
  assert.equal(body["template"], "engineering");
  assert.equal(Wz.wizardReducer(w, { type: "unknown" }), w);
  assert.equal(Wz.wizardReducer(w, { type: "reset" }).draft.name, "");
});

/* ---------- API client with a fake fetch ---------- */
interface Call { path: string; init: { method: string; headers?: Record<string, string>; body?: string } }
function fakeFetch(replies: Array<{ status: number; body: unknown } | Error>): { f: (p: string, i: Call["init"]) => Promise<unknown>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    f: async (path, init) => {
      calls.push({ path, init });
      const r = replies.shift();
      if (!r) throw new Error("no reply queued");
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    },
  };
}

test("api client sends the contract's requests", async () => {
  const fx = fakeFetch([{ status: 200, body: { departments: [] } }, { status: 201, body: { department: { id: "x" }, etag: "v1" } }, { status: 200, body: {} }, { status: 200, body: { exists: true } }, { status: 200, body: {} }, { status: 200, body: {} }]);
  const api = Api.createDeptApi(fx.f);
  await api["list"]!();
  await api["create"]!({ name: "X", template: "custom" });
  await api["update"]!("a/b", { id: "a/b" }, "v7");
  await api["checkSource"]!("back-office", "D:\\r", "git");
  await api["remove"]!("back-office", false);
  await api["remove"]!("back-office", true);
  assert.deepEqual(fx.calls.map((c) => `${c.init.method} ${c.path}`), ["GET /api/departments", "POST /api/departments", "PUT /api/departments/a%2Fb", "POST /api/departments/back-office/sources/check", "DELETE /api/departments/back-office", "DELETE /api/departments/back-office"]);
  assert.equal(fx.calls[0]!.init.body, undefined);
  assert.deepEqual(JSON.parse(fx.calls[2]!.init.body!), { department: { id: "a/b" }, etag: "v7" });
  assert.deepEqual(JSON.parse(fx.calls[3]!.init.body!), { path: "D:\\r", kind: "git" });
  assert.deepEqual(JSON.parse(fx.calls[4]!.init.body!), { confirm: "back-office" });
  assert.deepEqual(JSON.parse(fx.calls[5]!.init.body!), { confirm: "back-office", purge: true });
  assert.equal(fx.calls[1]!.init.headers!["Content-Type"], "application/json");
});

test("api client returns server errors verbatim and never throws", async () => {
  const fx = fakeFetch([{ status: 409, body: { error: "Etag is stale." } }, { status: 500, body: {} }, new Error("offline")]);
  const api = Api.createDeptApi(fx.f);
  const a = await api["update"]!("x", {}, "v1");
  assert.deepEqual([a.ok, a.status, a.data["error"]], [false, 409, "Etag is stale."]);
  const b = await api["get"]!("x");
  assert.equal(b.data["error"], "Request failed (500)");
  const c = await api["list"]!();
  assert.equal(c.status, 0);
  assert.match(String(c.data["error"]), /reach the server/);
});

test("withDept adds the department to GET paths and POST bodies, not to department endpoints", () => {
  assert.equal(Api.withDept("/api/inbox", undefined, "back-office").path, "/api/inbox?dept=back-office");
  assert.equal(Api.withDept("/api/doc?ref=a b", undefined, "e&r").path, "/api/doc?ref=a b&dept=e%26r");
  assert.deepEqual(Api.withDept("/api/chats", { x: 1 }, "back-office").body, { dept: "back-office", x: 1 });
  assert.equal(Api.withDept("/api/departments/back-office", undefined, "back-office").path, "/api/departments/back-office");
  assert.equal(Api.withDept("/api/inbox", undefined, null).path, "/api/inbox");
});

test("colours are the registry names; ids are at least two characters", () => {
  assert.deepEqual([...D.COLORS].sort(), ["amber", "blue", "green", "orange", "rose", "slate", "teal", "violet"]);
  assert.equal(D.isColor("blue"), true);
  assert.equal(D.isColor("#2f7de1"), false);
  assert.equal(D.isColor(null), false);
  assert.match(D.colorHex("rose"), /^#[0-9a-f]{6}$/);
  assert.match(D.colorHex(null), /^#[0-9a-f]{6}$/, "a department with no colour still gets a swatch");
  assert.equal(D.uniqueId("A", []), "a-1");
  assert.equal(D.emptyDepartment().color, "blue");
});
