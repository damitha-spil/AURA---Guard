// A small unified diff of two texts. Used only when a host gives file contents but no patch (Azure DevOps).

/** Compare at most this many (old lines x new lines) cells after common lines are trimmed: bounds memory (4 bytes each). */
export const MAX_DIFF_CELLS = 4_000_000;
const CONTEXT = 3;

type Op = { t: " " | "+" | "-"; text: string };

const lines = (s: string): string[] => {
  const out = s.replace(/\r\n/g, "\n").split("\n");
  if (out.at(-1) === "") out.pop();
  return out;
};

/** Edit script between two line lists, or null when they are too different to compare cheaply. */
function script(a: string[], b: string[]): Op[] | null {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length, eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const n = ea - lo, m = eb - lo;
  if (n * m > MAX_DIFF_CELLS) return null;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[lo + i] === b[lo + j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    }
  }
  const ops: Op[] = a.slice(0, lo).map((text) => ({ t: " ", text }));
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[lo + i] === b[lo + j]) { ops.push({ t: " ", text: a[lo + i]! }); i++; j++; }
    else if (j < m && (i === n || t[i * w + j + 1]! >= t[(i + 1) * w + j]!)) { ops.push({ t: "+", text: b[lo + j]! }); j++; }
    else { ops.push({ t: "-", text: a[lo + i]! }); i++; }
  }
  for (const text of a.slice(ea)) ops.push({ t: " ", text });
  return ops;
}

export interface PatchInput { path: string; oldPath?: string; oldText: string | null; newText: string | null }

/** A git-style patch (with the `diff --git` header), or null when the files are too different to compare here. */
export function unifiedPatch(f: PatchInput): { patch: string; additions: number; deletions: number } | null {
  const a = f.oldText === null ? [] : lines(f.oldText);
  const b = f.newText === null ? [] : lines(f.newText);
  const ops = script(a, b);
  if (!ops) return null;
  const oldPath = f.oldPath ?? f.path;
  const head = [`diff --git a/${oldPath} b/${f.path}`];
  if (f.oldText === null) head.push("new file mode 100644");
  else if (f.newText === null) head.push("deleted file mode 100644");
  else if (oldPath !== f.path) head.push(`rename from ${oldPath}`, `rename to ${f.path}`);

  const additions = ops.filter((o) => o.t === "+").length;
  const deletions = ops.filter((o) => o.t === "-").length;
  if (!additions && !deletions) return { patch: head.join("\n"), additions, deletions };

  head.push(f.oldText === null ? "--- /dev/null" : `--- a/${oldPath}`, f.newText === null ? "+++ /dev/null" : `+++ b/${f.path}`);
  // Where each op sits in the old and new file.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0, n = 0;
  for (const op of ops) { oldBefore.push(o); newBefore.push(n); if (op.t !== "+") o++; if (op.t !== "-") n++; }

  const out = [...head];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.t === " ") { i++; continue; }
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j]!.t !== " ") { end = j; j++; continue; }
      let k = j;
      while (k < ops.length && ops[k]!.t === " ") k++;
      if (k < ops.length && k - j <= CONTEXT * 2) { j = k; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + 1 + CONTEXT);
    const slice = ops.slice(start, stop);
    const oldCount = slice.filter((x) => x.t !== "+").length;
    const newCount = slice.filter((x) => x.t !== "-").length;
    const oldStart = oldCount === 0 ? oldBefore[start]! : oldBefore[start]! + 1;
    const newStart = newCount === 0 ? newBefore[start]! : newBefore[start]! + 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const x of slice) out.push(x.t + x.text);
    i = stop;
  }
  return { patch: out.join("\n"), additions, deletions };
}
