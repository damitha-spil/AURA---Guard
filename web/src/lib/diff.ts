// Reads one file's unified patch into lines for the two diff layouts.

export interface DiffLine {
  kind: "hunk" | "add" | "del" | "same" | "meta";
  /** The whole patch line, with its +, - or space marker. */
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  const rows = patch.replace(/\n$/, "").split("\n");
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const text of rows) {
    const hunk = /^@@+ -(\d+)(?:,\d+)? .*?\+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      out.push({ kind: "hunk", text, oldNo: null, newNo: null });
    } else if (text.startsWith("diff --git ")) {
      inHunk = false;
    } else if (!inHunk) {
      // File headers repeat the path already shown above the patch.
      if (!/^(index |--- |\+\+\+ )/.test(text) && text) out.push({ kind: "meta", text, oldNo: null, newNo: null });
    } else if (text.startsWith("+")) {
      out.push({ kind: "add", text, oldNo: null, newNo: newNo++ });
    } else if (text.startsWith("-")) {
      out.push({ kind: "del", text, oldNo: oldNo++, newNo: null });
    } else if (text.startsWith("\\")) {
      out.push({ kind: "meta", text, oldNo: null, newNo: null });
    } else {
      out.push({ kind: "same", text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return out;
}

export type SplitRow = { full: DiffLine } | { left: DiffLine | null; right: DiffLine | null };

/** Side by side: each run of removed lines sits beside the added lines that follow it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === "del") {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.kind === "add") adds.push(l);
    else {
      flush();
      rows.push(l.kind === "same" ? { left: l, right: l } : { full: l });
    }
  }
  flush();
  return rows;
}
