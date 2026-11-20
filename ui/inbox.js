// Pure helpers for the review inbox. No DOM access, so the Node tests can import this file.
// Every value from a note is HTML-escaped before it goes into the card markup.

import { escapeHtml } from "./render.js";

const SOURCE_LABEL = {
  session: "Session",
  "pr-comment": "PR comment",
  commit: "Commit",
  import: "Import",
  evidence: "Evidence",
  "owner-answer": "Owner answer",
};

const TYPE_LABEL = {
  rule: "Rules",
  adr: "Decisions (ADR)",
  pattern: "Patterns",
  incident: "Incidents",
  domain: "Domain",
  diary: "Diary",
  choice: "Choices",
  journey: "Journeys",
};

export const typeLabel = (t) => TYPE_LABEL[t] || String(t);
export const sourceLabel = (s) => SOURCE_LABEL[s] || String(s);

/** "today", "yesterday", "3 days ago", "5 weeks ago" from a YYYY-MM-DD date. */
export function ageLabel(created, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(created || ""));
  if (!m) return "";
  const then = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** What Approve will switch on. Said plainly, before the click. */
export function approveHint(item) {
  if (item.type === "pattern" || item.type === "rule") {
    return item.evidence
      ? "Approve: becomes an active check for the reviewer."
      : "Approve: becomes an active rule that chat and search use.";
  }
  return "Approve: becomes an active note that chat and search use.";
}

export function evidenceText(item) {
  const e = item.evidence;
  if (!e) return item.checkInvalid ? "The check block in this note is not valid, so Approve will be refused." : "";
  const pct = Math.round(e.ratio * 100);
  return `Seen in ${e.commits} commits (${pct}%) in ${e.repo}`;
}

/** One card as an HTML string. `now` is injectable for tests. */
export function renderCard(item, now = new Date()) {
  const id = escapeHtml(item.id);
  const anchors = item.anchors ? `<span class="meta-pill">${item.anchors} code ${item.anchors === 1 ? "anchor" : "anchors"}</span>` : "";
  const ev = evidenceText(item);
  const evHtml = ev ? `<span class="meta-pill${item.checkInvalid ? " meta-warn" : ""}">${escapeHtml(ev)}</span>` : "";
  const age = ageLabel(item.created, now);
  return (
    `<article class="card" data-id="${id}" tabindex="0" aria-label="${escapeHtml(item.title)}">` +
    `<header class="card-head"><h3 class="card-title">${escapeHtml(item.title)}</h3>` +
    `<span class="tag-source">${escapeHtml(sourceLabel(item.source))}</span></header>` +
    `<p class="card-sub"><code>${id}</code>${age ? `<span class="card-age">${escapeHtml(age)}</span>` : ""}</p>` +
    `<p class="card-preview">${escapeHtml(item.preview || "(no text)")}</p>` +
    (anchors || evHtml ? `<div class="card-meta">${anchors}${evHtml}</div>` : "") +
    `<p class="card-hint">${escapeHtml(approveHint(item))}</p>` +
    `<div class="card-actions">` +
    `<button type="button" class="btn btn-primary" data-act="approve"${item.checkInvalid ? " disabled" : ""}>Approve</button>` +
    `<button type="button" class="btn btn-danger" data-act="dismiss">Dismiss</button>` +
    `<button type="button" class="btn" data-act="open">Open</button>` +
    `</div></article>`
  );
}

/** All groups as HTML: a heading with a count badge, then the cards. */
export function renderGroups(groups, now = new Date()) {
  return groups
    .map(
      (g) =>
        `<section class="group" aria-label="${escapeHtml(typeLabel(g.type))}">` +
        `<h2 class="group-title">${escapeHtml(typeLabel(g.type))}<span class="badge">${Number(g.count) || 0}</span></h2>` +
        g.items.map((i) => renderCard(i, now)).join("") +
        `</section>`,
    )
    .join("");
}

const KIND_LABEL = {
  review: "Reviews",
  "qa-plan": "QA plans",
  daily: "Daily",
  quiz: "Quiz",
  logcheck: "Log check",
  "support-export": "Support export",
};
export const kindLabel = (k) => KIND_LABEL[k] || String(k);
export const KIND_ORDER = ["review", "qa-plan", "daily", "quiz", "logcheck", "support-export"];

/** "2026-11-20 07:10" in the viewer's own time zone. */
export function localStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sizeLabel(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
}

/** Report list grouped by kind, newest first inside each group. Returns HTML. */
export function renderReportList(reports) {
  const by = new Map();
  for (const r of reports) {
    if (!by.has(r.kind)) by.set(r.kind, []);
    by.get(r.kind).push(r);
  }
  const kinds = [...by.keys()].sort((a, b) => (KIND_ORDER.indexOf(a) + 99) % 99 - (KIND_ORDER.indexOf(b) + 99) % 99);
  return kinds
    .map((k) => {
      const list = by.get(k).slice().sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
      return (
        `<section class="rgroup"><h2 class="group-title">${escapeHtml(kindLabel(k))}<span class="badge">${list.length}</span></h2>` +
        list
          .map(
            (r) =>
              `<button type="button" class="report-item" data-path="${escapeHtml(r.path)}" title="${escapeHtml(r.path)}">` +
              `<span class="report-name">${escapeHtml(r.name)}</span>` +
              `<span class="report-meta">${escapeHtml(localStamp(r.mtime))} - ${escapeHtml(sizeLabel(r.size))}</span></button>`,
          )
          .join("") +
        `</section>`
      );
    })
    .join("");
}
