// Short chat titles from a first question. Pure: no DOM, importable in Node.

export const TITLE_MAX = 38;

/** "Why does the AI never get an ERP create tool?" -> "Why does the AI never get an ERP..." */
export function shortTitle(text, max = TITLE_MAX) {
  let t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  t = t.replace(/[?!.:;,\s]+$/, "");
  if (!t) return "New chat";
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    t = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:\s]+$/, "") + "...";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}
