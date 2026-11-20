// Safe text renderer. Everything is HTML-escaped FIRST; only then are a few patterns turned into tags.
// Supports paragraphs, bold, inline code, fenced code blocks, lists, and links to internal guard: refs.
// Loaded by the page and by the Node tests (it has no DOM access).

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Inline patterns on already-escaped text. Code spans are cut out first so nothing inside them is touched. */
function inline(escaped, known) {
  return escaped
    .split(/(`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${part.slice(1, -1)}</code>`;
      return part
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]\n]+)\]\(guard:([^)\s]+)\)/g, (_m, label, ref) => `<button type="button" class="cite" data-ref="${ref}">${label}</button>`)
        .replace(/\[([^\[\]\n]+)\](?!\()/g, (m, ref) =>
          known && known.has(unescapeBasic(ref)) ? `<button type="button" class="cite" data-ref="${ref}">${ref}</button>` : m,
        );
    })
    .join("");
}

function unescapeBasic(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/;

/** A Markdown table. Cells are escaped first, like every other line. */
function table(rows, known) {
  const cells = (r) => r.trim().slice(1, -1).split("|").map((c) => inline(escapeHtml(c.trim()), known));
  const [head, ...body] = rows;
  return (
    '<div class="table-wrap"><table><thead><tr>' + cells(head).map((c) => `<th>${c}</th>`).join("") + "</tr></thead><tbody>" +
    body.map((r) => "<tr>" + cells(r).map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") +
    "</tbody></table></div>"
  );
}

function blocks(text, known) {
  const html = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map((l) => inline(escapeHtml(l), known)).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(escapeHtml(i), known)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? "")) {
      flushPara();
      flushList();
      const rows = [line];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(lines[i++]);
      i--;
      html.push(table(rows, known));
      continue;
    }
    const ul =/^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ul || ol)[1]);
    } else if (h) {
      flushPara();
      flushList();
      html.push(`<p><strong>${inline(escapeHtml(h[1]), known)}</strong></p>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return html.join("");
}

/** @param {string} text  @param {Set<string>} [known] refs that may be shown as clickable citations */
export function renderSafe(text, known) {
  const src = String(text ?? "").replace(/\r\n?/g, "\n");
  const out = [];
  const re = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push(blocks(src.slice(last, m.index), known));
    out.push(`<pre><code>${escapeHtml((m[1] ?? "").replace(/\n$/, ""))}</code></pre>`);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out.push(blocks(src.slice(last), known));
  return out.join("");
}
