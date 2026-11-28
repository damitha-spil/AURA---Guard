// Replaces the old safe-renderer escaping tests. The React app has no markdown or HTML renderer: chat
// replies, documents, diffs and PR text are plain React text, which React escapes. These source
// checks fail when someone adds a way to turn text into markup, script or a link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const web = join(import.meta.dirname, "..", "..", "web");
// Loaded by path: web/ is outside the engine's TypeScript project.
const { safeUrl } = (await import(pathToFileURL(join(web, "src", "lib", "pulls.ts")).href)) as { safeUrl: (url: string | null) => string | null };
const files = readdirSync(join(web, "src"), { recursive: true, encoding: "utf8" })
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ name: f.replace(/\\/g, "/"), text: readFileSync(join(web, "src", f), "utf8") }));
const using = (re: RegExp): string[] => files.filter((f) => re.test(f.text)).map((f) => f.name);

test("web: nothing turns a string into HTML or script", () => {
  assert.ok(files.length > 20, "the sources were found");
  for (const re of [/dangerouslySetInnerHTML/, /\.(inner|outer)HTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\b/, /\bsrcDoc\b/, /<iframe\b/]) {
    assert.deepEqual(using(re), [], String(re));
  }
});

test("web: no markdown-to-HTML library is installed", () => {
  const pkg = JSON.parse(readFileSync(join(web, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.ok(!/markdown|marked|remark|rehype|showdown|html-react-parser/i.test(name), `${name}: add escaping and link tests before using it`);
  }
});

test("web: no link or frame takes its address from data", () => {
  // A new dynamic href, src or navigation needs its own protocol check and a test here.
  // The one image is a stored attachment whose address comes from attachmentUrl (lib/chat.ts), which accepts only two engine ids.
  assert.deepEqual(using(/\b(href|src|formAction)=\{|<form\b[^>]*\saction=/), ["components/app/attachments.tsx"]);
  const viewer = files.find((f) => f.name === "components/app/attachments.tsx")!.text;
  assert.match(viewer, /const imageUrl = [^;]*attachmentUrl\(/);
  assert.equal((viewer.match(/\b(?:src|href)=\{/g) ?? []).length, 1);
  assert.deepEqual(using(/\blocation\.(href\s*=|assign\(|replace\()/), []);
  // The one window.open shows the defect report the engine built (it escapes every field) from a blob.
  assert.deepEqual(using(/window\.open\(/), ["views/DefectsView.tsx"]);
});

test("web: only https pull request links are used", () => {
  assert.equal(safeUrl("https://github.com/o/r/pull/1"), "https://github.com/o/r/pull/1");
  for (const bad of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<script>1</script>", "http://github.com/x", "file:///c:/x", "//evil.example", "/api/x", "", null]) {
    assert.equal(safeUrl(bad), null, String(bad));
  }
});
