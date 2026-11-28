// Read-only previews of data files: a CSV or TSV as a small table, JSON pretty-printed. The result is data
// only; the viewer shows it as React text, which escapes it. Capped, so a big file stays quick.

export const PREVIEW_ROWS = 50;
export const PREVIEW_COLS = 12;
export const PREVIEW_CELL = 120;

export interface TablePreview { kind: "table"; head: string[]; rows: string[][]; more: boolean }
export interface JsonPreview { kind: "json"; text: string; more: boolean }

function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length && rows.length <= PREVIEW_ROWS; i++) {
    const c = text[i]!;
    if (q) {
      if (c === "\"" && text[i + 1] === "\"") { cell += "\""; i++; } else if (c === "\"") q = false; else cell += c;
    } else if (c === "\"") q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function previewOf(name: string, text: string): TablePreview | JsonPreview | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === "csv" || ext === "tsv") {
    const rows = parseDelimited(text.slice(0, 200_000), ext === "tsv" ? "\t" : ",");
    if (rows.length < 1) return null;
    const clip = (c: string): string => (c.length > PREVIEW_CELL ? c.slice(0, PREVIEW_CELL) + "..." : c);
    const cut = (r: string[]): string[] => r.slice(0, PREVIEW_COLS).map(clip);
    return { kind: "table", head: cut(rows[0]!), rows: rows.slice(1, PREVIEW_ROWS + 1).map(cut), more: rows.length > PREVIEW_ROWS + 1 };
  }
  if (ext === "json") {
    try {
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      return { kind: "json", text: pretty.slice(0, 20_000), more: pretty.length > 20_000 };
    } catch {
      return null;
    }
  }
  return null;
}

/** What kind of file this looks like and, when REO cannot tell what to do with it, the one question to ask. */
export function triage(f: { name: string; kind?: string; status?: string }): { what: string; question?: string; choices?: string[] } {
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? "";
  if (f.status === "blocked") return { what: "A file that looks like it holds a secret. It was not sent." };
  if (f.kind === "image") return { what: "A picture. REO shows it but cannot read it.", question: "REO cannot read pictures. Say what you want to know about it in your message." };
  if (f.status === "unreadable") return { what: "A file REO could not read.", question: "REO could not read this file. What should it do?", choices: ["Tell me why it could not be read", "Ignore it"] };
  if (ext === "csv" || ext === "tsv" || ext === "xlsx") return { what: "A table of data.", question: "What would you like from this data?", choices: ["Summarise it", "Find problems in it", "Explain the columns"] };
  if (ext === "json" || ext === "yml" || ext === "yaml") return { what: "A data or settings file." };
  if (f.kind === "pdf" || f.kind === "docx") return { what: "A document.", question: "What would you like from this document?", choices: ["Summarise it", "List the action items", "Find risks or gaps"] };
  if (f.kind === "text" && /^(ts|tsx|js|jsx|py|java|rs|go|cs|sql|sh|ps1)$/.test(ext)) return { what: "Source code.", question: "What should REO do with this code?", choices: ["Review it", "Explain it", "Find bugs"] };
  if (f.kind === "text") return { what: "A text file." };
  return { what: "A file of an unknown kind.", question: "REO is not sure what this is. What should it do with it?", choices: ["Read it as text", "Ignore it"] };
}
