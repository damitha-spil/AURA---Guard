// The live step list. Steps are real events from the server; this keeps them in order.
// Pure: no DOM, importable in Node.

/** Applies one step event to a list. The same id updates its row; a new id is appended. */
export function applyStep(steps, step, now = Date.now()) {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i < 0) return [...steps, { ...step, startedAt: now }];
  const old = steps[i];
  const next = steps.slice();
  next[i] = { ...old, ...step, startedAt: old.startedAt };
  return next;
}

/** Rows shown to the person: the closing "done" marker is not a step of work. */
export const workSteps = (steps) => steps.filter((s) => s.kind !== "done");

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 950) return "under 1 s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** "Worked for 4 s - 5 steps" (the dot is the middle dot character). */
export function summarize(steps, totalMs) {
  const n = workSteps(steps).length;
  return `Worked for ${formatDuration(totalMs) || "under 1 s"} · ${n} ${n === 1 ? "step" : "steps"}`;
}

/** Total time: the "done" step carries it; otherwise the fallback. */
export function totalMs(steps, fallback = 0) {
  const d = steps.find((s) => s.kind === "done");
  return d && typeof d.ms === "number" ? d.ms : fallback;
}

/** Status icon name for a row. */
export const stepIcon = (s) => (s.status === "running" ? "spinner" : s.status === "error" ? "error" : "check");

/** Splits an NDJSON buffer into complete events and the unfinished rest. Bad lines are skipped. */
export function splitEvents(buffer) {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const events = [];
  for (const line of parts) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip a damaged line */
    }
  }
  return { events, rest };
}

/** Human-readable span category for the live execution waterfall. */
export function stepKindLabel(kind) {
  if (kind === "design" || kind === "model") return "LLM";
  if (kind === "safety" || kind === "verify") return "Guard";
  if (kind === "run") return "Runner";
  if (kind === "context" || kind === "search" || kind === "found") return "Context";
  if (kind === "report") return "Artifact";
  return "Step";
}

/** Computes waterfall offsets (%) and widths (%) for a list of steps. */
export function computeWaterfall(steps) {
  const list = workSteps(steps);
  if (list.length === 0) return [];
  const t0 = list[0].startedAt ?? 0;
  let maxEnd = 0;
  const raw = list.map((s, idx) => {
    const start = Math.max(0, (s.startedAt ?? t0) - t0);
    const dur = Math.max(10, typeof s.ms === "number" ? s.ms : 50);
    const end = start + dur;
    if (end > maxEnd) maxEnd = end;
    return { ...s, index: idx, offsetMs: start, durationMs: dur };
  });
  const total = Math.max(1, maxEnd);
  return raw.map((r) => ({
    ...r,
    kindLabel: stepKindLabel(r.kind),
    leftPct: Math.min(96, Math.round((r.offsetMs / total) * 100)),
    widthPct: Math.max(4, Math.min(100, Math.round((r.durationMs / total) * 100))),
  }));
}
