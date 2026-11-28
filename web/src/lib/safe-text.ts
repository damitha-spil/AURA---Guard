// REO's own small renderer, part 1: parsing. Text in, plain data out (blocks and inline pieces). No HTML
// is ever made here. The React part (components/app/safe-text.tsx) turns this data into React elements.
// Supported: headings, lists, bold, italic, inline code, fenced code blocks, pipe tables, links shown as
// plain text, and "reo-card" blocks (strict JSON schema, capped). Anything else stays as plain text.

export type Inline =
  | { t: "text"; s: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "code"; s: string }
  /** A link is shown as its text and its address as plain text; the address can be copied, never opened. */
  | { t: "link"; s: string; url: string };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "code"; lang: string; s: string }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "card"; card: Card }
  | { t: "badcard"; raw: string };

/** Longest text the renderer formats; longer text is shown plain. */
export const MAX_RENDER_CHARS = 30_000;
export const MAX_NESTING = 3;

const URL_OK = /^https?:\/\/[^\s<>"'`]{1,500}$/i;

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let buf = "";
  const flush = (): void => { if (buf) { out.push({ t: "text", s: buf }); buf = ""; } };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) { flush(); out.push({ t: "code", s: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if (depth < MAX_NESTING && (src.startsWith("**", i) || src.startsWith("__", i))) {
      const end = src.indexOf(src.slice(i, i + 2), i + 2);
      if (end > i + 2) { flush(); out.push({ t: "b", c: parseInline(src.slice(i + 2, end), depth + 1) }); i = end + 2; continue; }
    }
    if (depth < MAX_NESTING && (ch === "*" || ch === "_") && src[i + 1] !== " " && src[i + 1] !== ch) {
      const end = src.indexOf(ch, i + 1);
      // Underscores inside a word (snake_case) are not emphasis.
      const word = ch === "_" && /[A-Za-z0-9]/.test(src[i - 1] ?? " ");
      if (end > i + 1 && src[end - 1] !== " " && !word) { flush(); out.push({ t: "i", c: parseInline(src.slice(i + 1, end), depth + 1) }); i = end + 1; continue; }
    }
    if (ch === "[") {
      const m = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/.exec(src.slice(i));
      if (m) {
        flush();
        // Only http(s) addresses are kept as links; any other scheme stays visible as text.
        out.push(URL_OK.test(m[2]!) ? { t: "link", s: m[1]!, url: m[2]! } : { t: "text", s: m[0] });
        i += m[0].length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}
const isSep = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");

export function parseBlocks(text: string): Block[] {
  if (text.length > MAX_RENDER_CHARS) return [{ t: "p", c: [{ t: "text", s: text }] }];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = (): void => { if (para.length) { blocks.push({ t: "p", c: parseInline(para.join("\n")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) body.push(lines[j++]!);
      i = j; // an unclosed fence runs to the end (a streaming reply)
      const lang = fence[1]!.toLowerCase();
      const raw = body.join("\n");
      blocks.push(lang === "reo-card" ? parseCard(raw) : { t: "code", lang, s: raw });
      continue;
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { flushPara(); blocks.push({ t: "h", level: Math.min(3, h[1]!.length) as 1 | 2 | 3, c: parseInline(h[2]!) }); continue; }
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1]!)) {
      flushPara();
      const head = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim()) rows.push(splitRow(lines[j++]!));
      i = j - 1;
      blocks.push({ t: "table", head: head.slice(0, 8).map((c) => parseInline(c)), rows: rows.slice(0, 100).map((r) => r.slice(0, 8).map((c) => parseInline(c))) });
      continue;
    }
    const li = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[1]!);
      const items: Inline[][] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[j]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        items.push(parseInline(m[2]!));
      }
      i = j - 1;
      blocks.push({ t: ordered ? "ol" : "ul", items: items.slice(0, 200) });
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return blocks;
}

// ---- answer cards ----

export type Card =
  | { card: "table"; columns: string[]; rows: string[][] }
  | { card: "checklist"; items: { text: string; done: boolean }[] }
  | { card: "keyvalue"; pairs: { k: string; v: string }[] }
  | { card: "status"; items: { label: string; status: "ok" | "warn" | "fail" | "info" }[] }
  | { card: "progress"; label: string; value: number; max: number }
  | { card: "chart"; type: "bar" | "line"; data: { label: string; value: number }[] }
  | { card: "diagram"; nodes: { id: string; label: string }[]; edges: { from: string; to: string }[] };

/** Caps: a card is a small summary, not a data dump. */
export const CARD_LIMITS = { rows: 50, columns: 8, items: 30, points: 50, nodes: 12, edges: 24, text: 200 } as const;

const txt = (v: unknown, max: number = CARD_LIMITS.text): string | null => (typeof v === "string" || typeof v === "number" ? String(v).slice(0, max) : null);

/** Validates one card strictly; anything off gives null and the block is shown as plain text. */
export function validateCard(v: unknown): Card | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const L = CARD_LIMITS;
  const list = (x: unknown, max: number): unknown[] | null => (Array.isArray(x) && x.length > 0 && x.length <= max ? x : null);
  switch (o["card"]) {
    case "table": {
      const cols = list(o["columns"], L.columns)?.map((c) => txt(c, 60));
      const rows = list(o["rows"], L.rows);
      if (!cols || cols.some((c) => c === null) || !rows) return null;
      const out: string[][] = [];
      for (const r of rows) {
        if (!Array.isArray(r) || r.length > cols.length) return null;
        const cells = r.map((c) => txt(c));
        if (cells.some((c) => c === null)) return null;
        out.push(cells as string[]);
      }
      return { card: "table", columns: cols as string[], rows: out };
    }
    case "checklist": {
      const items = list(o["items"], L.items);
      if (!items) return null;
      const out: { text: string; done: boolean }[] = [];
      for (const it of items) {
        const t = txt((it as Record<string, unknown>)?.["text"]);
        if (t === null) return null;
        out.push({ text: t, done: (it as Record<string, unknown>)["done"] === true });
      }
      return { card: "checklist", items: out };
    }
    case "keyvalue": {
      const pairs = list(o["pairs"], L.items);
      if (!pairs) return null;
      const out: { k: string; v: string }[] = [];
      for (const p of pairs) {
        const k = txt((p as Record<string, unknown>)?.["k"], 80);
        const val = txt((p as Record<string, unknown>)?.["v"]);
        if (k === null || val === null) return null;
        out.push({ k, v: val });
      }
      return { card: "keyvalue", pairs: out };
    }
    case "status": {
      const items = list(o["items"], L.items);
      if (!items) return null;
      const out: { label: string; status: "ok" | "warn" | "fail" | "info" }[] = [];
      for (const it of items) {
        const label = txt((it as Record<string, unknown>)?.["label"]);
        const st = (it as Record<string, unknown>)?.["status"];
        if (label === null || (st !== "ok" && st !== "warn" && st !== "fail" && st !== "info")) return null;
        out.push({ label, status: st });
      }
      return { card: "status", items: out };
    }
    case "progress": {
      const label = txt(o["label"], 120);
      const value = Number(o["value"]);
      const max = Number(o["max"]);
      if (label === null || !Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value < 0 || value > max * 1.0001) return null;
      return { card: "progress", label, value, max };
    }
    case "chart": {
      const type = o["type"] === "line" ? "line" : o["type"] === "bar" ? "bar" : null;
      const data = list(o["data"], L.points);
      if (!type || !data) return null;
      const out: { label: string; value: number }[] = [];
      for (const d of data) {
        const label = txt((d as Record<string, unknown>)?.["label"], 40);
        const value = Number((d as Record<string, unknown>)?.["value"]);
        if (label === null || !Number.isFinite(value)) return null;
        out.push({ label, value });
      }
      return { card: "chart", type, data: out };
    }
    case "diagram": {
      const nodes = list(o["nodes"], L.nodes);
      const edgesRaw = Array.isArray(o["edges"]) ? o["edges"] : [];
      if (!nodes || edgesRaw.length > L.edges) return null;
      const ns: { id: string; label: string }[] = [];
      for (const n of nodes) {
        const id = txt((n as Record<string, unknown>)?.["id"], 20);
        const label = txt((n as Record<string, unknown>)?.["label"], 40);
        if (id === null || label === null || ns.some((x) => x.id === id)) return null;
        ns.push({ id, label });
      }
      const es: { from: string; to: string }[] = [];
      for (const e of edgesRaw) {
        const from = txt((e as Record<string, unknown>)?.["from"], 20);
        const to = txt((e as Record<string, unknown>)?.["to"], 20);
        if (from === null || to === null || !ns.some((n) => n.id === from) || !ns.some((n) => n.id === to)) return null;
        es.push({ from, to });
      }
      return { card: "diagram", nodes: ns, edges: es };
    }
    default:
      return null;
  }
}

export function parseCard(raw: string): Block {
  if (raw.length > 12_000) return { t: "badcard", raw };
  try {
    const card = validateCard(JSON.parse(raw));
    return card ? { t: "card", card } : { t: "badcard", raw };
  } catch {
    return { t: "badcard", raw };
  }
}

/** A diagram laid out in columns by depth: pure arithmetic, so it can be drawn as plain SVG shapes. */
export function layoutDiagram(nodes: { id: string; label: string }[], edges: { from: string; to: string }[]): { boxes: { id: string; label: string; x: number; y: number }[]; lines: { x1: number; y1: number; x2: number; y2: number }[]; w: number; h: number } {
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) for (const e of edges) depth.set(e.to, Math.min(nodes.length - 1, Math.max(depth.get(e.to) ?? 0, (depth.get(e.from) ?? 0) + 1)));
  const perCol = new Map<number, number>();
  const BW = 120, BH = 34, GX = 50, GY = 18;
  const boxes = nodes.map((n) => {
    const col = depth.get(n.id) ?? 0;
    const row = perCol.get(col) ?? 0;
    perCol.set(col, row + 1);
    return { id: n.id, label: n.label, x: col * (BW + GX) + 4, y: row * (BH + GY) + 4 };
  });
  const at = new Map(boxes.map((b) => [b.id, b]));
  const lines = edges.map((e) => {
    const a = at.get(e.from)!, b = at.get(e.to)!;
    return { x1: a.x + BW, y1: a.y + BH / 2, x2: b.x, y2: b.y + BH / 2 };
  });
  const cols = Math.max(...boxes.map((b) => b.x)) + BW + 4;
  const rows = Math.max(...boxes.map((b) => b.y)) + BH + 4;
  return { boxes, lines, w: cols, h: rows };
}
