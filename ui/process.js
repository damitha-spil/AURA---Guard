// The process wave: a smooth line through hexagon nodes, big ghost numerals, titles and short text.
// Reusable: buildProcess(steps) returns an element; guardProcessSteps(project, data) describes the real
// Guard process from what the engine does. Every claim below is backed by code (see the notes per step).
// Inline SVG + DOM calls only. The line draws in once when it scrolls into view (not with reduced motion).

const NS = "http://www.w3.org/2000/svg";
const W = 1000;
const H = 190;

const sv = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

/** Pointy-top hexagon points around (cx, cy). */
export function hexPoints(cx, cy, r) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

/** A smooth left-to-right path through the points: each segment leaves and arrives horizontally. */
export function wavePath(points, width = W) {
  if (!points.length) return "";
  const pts = [{ x: 0, y: points[0].y }, ...points, { x: width, y: points[points.length - 1].y }];
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const mx = (a.x + b.x) / 2;
    d += ` C${mx.toFixed(1)},${a.y} ${mx.toFixed(1)},${b.y} ${b.x},${b.y}`;
  }
  return d;
}

const ICONS = {
  learn: "M5 5h10a3 3 0 0 1 3 3v11H8a3 3 0 0 1-3-3V5Zm0 11a3 3 0 0 1 3-3h10",
  review: "M6 4h12v16H6V4Zm3 5 2 2 4-4M9 15h6",
  qa: "M12 3 5 6v5.5c0 4.2 2.8 7.4 7 9 4.2-1.6 7-4.8 7-9V6l-7-3Zm-3 9 2.2 2.2L15.5 10",
  secure: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6v-9Zm6 3v3",
  improve: "M12 4v10m0-10-4 4m4-4 4 4M5 19h14",
};

/** steps: [{ n, title, desc, status, tone, icon }]. */
export function buildProcess(steps) {
  const root = el("div", "proc");
  const count = steps.length;
  const xs = steps.map((_, i) => ((i + 0.5) / count) * W);
  const ys = steps.map((_, i) => (i % 2 === 0 ? 120 : 70));

  const svg = sv("svg", { class: "proc-wave", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true", focusable: "false" });
  const defs = sv("defs");
  const blur = sv("filter", { id: "proc-blur", x: "-60%", y: "-60%", width: "220%", height: "220%" });
  blur.appendChild(sv("feGaussianBlur", { stdDeviation: 9 }));
  defs.appendChild(blur);
  svg.appendChild(defs);
  steps.forEach((s, i) => {
    const t = sv("text", { class: "proc-ghost", x: xs[i], y: ys[i] + 46, "text-anchor": "middle" });
    t.textContent = String(s.n);
    svg.appendChild(t);
  });
  svg.appendChild(sv("path", { class: "proc-line-bg", d: wavePath(xs.map((x, i) => ({ x, y: ys[i] }))), fill: "none" }));
  svg.appendChild(sv("path", { class: "proc-line", d: wavePath(xs.map((x, i) => ({ x, y: ys[i] }))), fill: "none", pathLength: 1 }));
  steps.forEach((s, i) => {
    const g = sv("g", { class: "proc-node" });
    g.style.setProperty("--i", String(i));
    g.appendChild(sv("ellipse", { class: "proc-glow", cx: xs[i], cy: ys[i] + 30, rx: 30, ry: 10, filter: "url(#proc-blur)" }));
    g.appendChild(sv("polygon", { class: "proc-hex", points: hexPoints(xs[i], ys[i], 34) }));
    const ic = sv("path", { class: "proc-ic", d: ICONS[s.icon] || ICONS.learn, transform: `translate(${xs[i] - 12} ${ys[i] - 12})`, fill: "none" });
    g.appendChild(ic);
    svg.appendChild(g);
  });
  root.appendChild(svg);

  const list = el("ol", "proc-list");
  steps.forEach((s, i) => {
    const li = el("li", "proc-step");
    li.style.setProperty("--i", String(i));
    const hex = el("span", "proc-mini");
    hex.setAttribute("aria-hidden", "true");
    const mini = sv("svg", { viewBox: "0 0 24 24", class: "i" });
    mini.appendChild(sv("path", { d: ICONS[s.icon] || ICONS.learn, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    hex.appendChild(mini);
    const num = el("span", "proc-num", s.n);
    num.setAttribute("aria-hidden", "true");
    const body = el("div", "proc-body");
    body.append(el("h3", "proc-title", s.title), el("p", "proc-desc", s.desc));
    if (s.status) body.appendChild(el("p", `proc-status ${s.tone || ""}`, s.status));
    li.append(hex, num, body);
    list.appendChild(li);
  });
  root.appendChild(list);

  // Draw the line in once, when it is first on screen.
  const reduced = (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) || document.documentElement.getAttribute("data-motion") === "reduced";
  if (reduced || typeof IntersectionObserver !== "function") root.classList.add("in", "still");
  else {
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        root.classList.add("in");
        io.disconnect();
      }
    }, { threshold: 0.25 });
    io.observe(root);
  }
  return root;
}

/**
 * The real Guard process. What backs each step:
 *  1 Learn: ingest reads the configured repos with read-only git and the vault into the SQLite index.
 *  2 Review: Tier 0 fixed checks on added lines (rules in roles/review-rules.json, co-change history, secret detectors).
 *  3 QA: the harness runs read-only tests under safety tiers 0 read, 1 local sandbox, 2 blocked (qa/safety.ts).
 *  4 Secure: outgoing model calls go through the mask; a call with a detected secret is not sent; an egress
 *    audit keeps the payload hash (mask/audit.ts).
 *  5 Improve: Guard writes notes as "proposed"; only the owner makes a note active.
 */
export function guardProcessSteps(project, data) {
  const idx = project && project.index;
  const qa = data && data.qa;
  const waiting = (data && data.inbox && data.inbox.total) ?? (project && project.inbox && project.inbox.pending) ?? 0;
  return [
    { n: 1, icon: "learn", title: "Learn", desc: "Reads your repositories and vault notes into a local search index. Git access is read-only.", status: idx && idx.indexedAt ? `${idx.files.toLocaleString("en")} files and ${idx.commits.toLocaleString("en")} commits indexed` : "Not indexed yet", tone: idx && idx.indexedAt ? "ok" : "warn" },
    { n: 2, icon: "review", title: "Review", desc: "Fixed checks run on the lines you add: your rules file, co-change history and secret detection. They need no model.", status: "Tier 0 checks", tone: "" },
    { n: 3, icon: "qa", title: "QA", desc: "The harness plans and runs read-only tests under safety tiers: T0 read, T1 local sandbox, T2 blocked.", status: qa ? (qa.totalRuns ? `${qa.totalRuns} runs, ${qa.totalDefects} defects found` : "No runs yet") : "", tone: qa && qa.totalRuns ? "ok" : "" },
    { n: 4, icon: "secure", title: "Secure", desc: "Every outgoing model call is masked first. A call with a detected secret is not sent, and each payload is logged by hash.", status: "Read-only by design", tone: "ok" },
    { n: 5, icon: "improve", title: "Improve", desc: "Guard proposes notes from what it learns. Only you can make a note active.", status: waiting ? `${waiting} ${waiting === 1 ? "note is" : "notes are"} waiting for you` : "Nothing is waiting", tone: waiting ? "warn" : "ok" },
  ];
}
