// The agent mark for each style. Pure: it builds elements through the document it is given, so
// Node tests can pass a tiny fake. Animation is CSS only (see styles.css, keyed on data-state).

export const STYLES = ["noir", "dots", "pulse", "aurora"];
export const DEFAULT_STYLE = "noir";
export const STATES = ["idle", "thinking", "error", "done"];
export const STYLE_NAMES = { dots: "Dots", pulse: "Pulse", noir: "Noir", aurora: "Aurora" };
export const STYLE_BLURBS = {
  dots: "Warm and calm, a grid of dots",
  pulse: "Clean and quiet, one dot",
  noir: "Dark, dense, serious",
  aurora: "Soft light, a glowing orb",
};
/** What each style does with the work steps. The Show work setting can override it. */
export const WORK_DEFAULTS = {
  noir: { live: true, expanded: true },
  dots: { live: true, expanded: false },
  pulse: { live: false, expanded: false },
  aurora: { live: true, expanded: false },
};

const KIND = { dots: "grid", pulse: "dot", noir: "squares", aurora: "orb" };
export const markKind = (style) => KIND[style] || KIND.noir;
export const isState = (s) => STATES.includes(s);
export const isStyle = (s) => STYLES.includes(s);

const NS = "http://www.w3.org/2000/svg";
const COORD = [5, 12, 19];

/** Plain description of the shapes in a mark, so tests can check it without a DOM. */
export function markShapes(style) {
  const kind = markKind(style);
  if (kind === "dot") return [{ tag: "circle", cx: 12, cy: 12, r: 5 }];
  if (kind === "orb") return [1, 2, 3, 4].map((n) => ({ tag: "i", cls: `blob b${n}` }));
  const out = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const centre = r === 1 && c === 1;
      const edge = (r === 1) !== (c === 1);
      if (kind === "squares") {
        const w = centre ? 5 : edge ? 4 : 3;
        out.push({ tag: "rect", x: COORD[c] - w / 2, y: COORD[r] - w / 2, width: w, height: w, rx: 0.6 });
      } else {
        out.push({ tag: "circle", cx: COORD[c], cy: COORD[r], r: centre ? 2.9 : edge ? 2.3 : 1.6 });
      }
    }
  }
  return out;
}

/** A mark element. `doc` is the document (or a compatible fake). */
export function buildMark(doc, style, state = "idle") {
  const kind = markKind(style);
  const root = doc.createElement("span");
  root.className = `mark mark-${kind}`;
  root.setAttribute("data-mark", style);
  root.setAttribute("data-kind", kind);
  root.setAttribute("data-state", isState(state) ? state : "idle");
  root.setAttribute("aria-hidden", "true");
  if (kind === "orb") {
    for (const sh of markShapes(style)) {
      const i = doc.createElement("i");
      i.className = sh.cls;
      root.appendChild(i);
    }
    return root;
  }
  const svg = doc.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const sh of markShapes(style)) {
    const n = doc.createElementNS(NS, sh.tag);
    for (const [k, v] of Object.entries(sh)) if (k !== "tag") n.setAttribute(k, String(v));
    svg.appendChild(n);
  }
  root.appendChild(svg);
  return root;
}

/** Replaces every mark under `root` with the one for `style`, keeping its state and extra classes. */
export function remountMarks(doc, root, style) {
  for (const old of [...root.querySelectorAll("[data-mark]")]) {
    const fresh = buildMark(doc, style, old.getAttribute("data-state") || "idle");
    for (const c of old.classList) if (!c.startsWith("mark")) fresh.classList.add(c);
    old.replaceWith(fresh);
  }
}

export function setMarkState(el, state) {
  if (el && isState(state)) el.setAttribute("data-state", state);
}

/**
 * What each style is, as data. styles.css has a rule set per [data-style]; the app uses this for the
 * things CSS cannot do (which empty state to build, how to reveal text, sidebar default).
 * Keep the two in step: the tests check every style has a descriptor and a mark.
 */
export const DESCRIPTORS = {
  noir: { id: "noir", mark: "squares", columnPx: 800, density: "dense", messages: "rows", workLive: true, workExpanded: true, topbar: true, sidebarDefault: "open", composer: "docked", reveal: "typewriter", entry: "instant", empty: "terminal", inbox: "table" },
  pulse: { id: "pulse", mark: "dot", columnPx: 680, density: "airy", messages: "airy", workLive: false, workExpanded: false, topbar: false, sidebarDefault: "collapsed", composer: "floating-large", reveal: "none", entry: "fade-up", empty: "single", inbox: "list" },
  dots: { id: "dots", mark: "grid", columnPx: 760, density: "comfortable", messages: "flat-avatar", workLive: true, workExpanded: false, topbar: true, sidebarDefault: "open", composer: "floating", reveal: "words", entry: "words", empty: "hero-cards", inbox: "cards" },
  aurora: { id: "aurora", mark: "orb", columnPx: 780, density: "roomy", messages: "cards", workLive: true, workExpanded: false, topbar: true, sidebarDefault: "open", composer: "floating-large", reveal: "none", entry: "rise-blur", empty: "orb-cards", inbox: "glass-cards" },
};
export const styleDescriptor = (style) => DESCRIPTORS[style] || DESCRIPTORS[DEFAULT_STYLE];
