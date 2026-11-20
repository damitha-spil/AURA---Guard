// Progressive reveal of a finished answer.
// NOTE: the backend returns the full answer at once. This is a presentation effect only: it
// changes how fast the text appears on screen, never what the answer says or when it was ready.
// Pure: no DOM, importable in Node.

export const MAX_REVEAL_MS = 1200;
export const WORD_MS = 28;

/** Where each word ends (character offsets) and how long to wait per word. */
export function planReveal(text, { maxMs = MAX_REVEAL_MS, wordMs = WORD_MS } = {}) {
  const s = String(text ?? "");
  const ends = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(s)) !== null) ends.push(m.index + m[0].length);
  const interval = ends.length ? Math.min(wordMs, maxMs / ends.length) : 0;
  return { ends, interval, total: Math.round(interval * ends.length), length: s.length };
}

/** How many characters are visible after `elapsedMs`. Whole words only; the full text at the end. */
export function revealedLength(plan, elapsedMs) {
  if (!plan.ends.length || elapsedMs >= plan.total) return plan.length;
  if (elapsedMs <= 0) return 0;
  const words = Math.min(plan.ends.length, Math.floor(elapsedMs / plan.interval) + 1);
  return plan.ends[words - 1];
}

/** Reveal is skipped under reduced motion and for empty text. */
export function shouldReveal({ reducedMotion, text }) {
  return !reducedMotion && String(text ?? "").trim().length > 0;
}
