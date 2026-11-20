import type { Turn } from "./read.ts";

export type CandidateKind = "correction" | "standing-rule" | "preference";

export interface Candidate {
  session: string;
  ts: string;
  context: string; // end of the previous assistant turn
  owner: string; // the owner's words
  kind: CandidateKind;
  score: number; // 0..1
}

const CONTEXT_MAX = 300;
const OWNER_MAX = 400;
/** Owner turns longer than this are specs or pastes, not corrections. */
const MAX_OWNER_LEN = 1200;

/** Pure approvals and acknowledgements: never candidates. */
const APPROVAL =
  /^(ok(ay)?|nice|yes|yep|yeah|y|good|great|perfect|thanks?( you)?|thx|commit( it)?|push( it)?|go( ahead)?|continue|proceed|sure|done|cool|looks good|lgtm|do it|sounds good|fine)[\s.!]*$/i;

interface Rule {
  re: RegExp;
  weight: number;
}

// Each heuristic adds its weight; the total is capped at 1.
const RULES: Rule[] = [
  // Opens with a rejection word.
  { re: /^\s*(no|nope|wrong|stop|wait|hold on|hmm|actually)\b/i, weight: 0.45 },
  // Prohibition.
  { re: /\b(don'?t|do not|dont|didn'?t ask|shouldn'?t|should not)\b/i, weight: 0.35 },
  // Says it is wrong.
  { re: /\bnot like (that|this)\b|\bthat'?s (wrong|not (what|right|correct))\b|\bwrong\b/i, weight: 0.4 },
  // Asks for an alternative.
  { re: /\binstead\b/i, weight: 0.35 },
  // "use X not Y".
  { re: /\buse\s+\S+(\s+\S+){0,3}\s+not\s+\S+/i, weight: 0.4 },
  // Asks to undo.
  { re: /\b(revert|undo|roll ?back|remove (it|that|this)|take (it|that) (out|off|back))\b/i, weight: 0.4 },
  // Repeats an earlier instruction.
  { re: /\bI (said|told you|asked)\b/i, weight: 0.45 },
  // Challenges an action.
  { re: /\bwhy (did|are|do) you\b/i, weight: 0.4 },
  // Standing-rule words.
  { re: /\b(never|always|from now on|remember (to|that)|every time|going forward)\b/i, weight: 0.4 },
  // Complains of excess.
  { re: /\b(too (much|long|big|many|complex|verbose)|overkill|over-?engineer|unnecessary|not needed|no need)\b/i, weight: 0.3 },
  // States a preference.
  { re: /\b(prefer|rather|better to|should be|make it)\b/i, weight: 0.2 },
];

const STANDING = /\b(always|never|from now on|remember|going forward|every time)\b/i;
const PREFERENCE = /\b(prefer|rather|instead|better to|should be|make it|use\s+\S+(\s+\S+){0,3}\s+not)\b/i;

/** End of the assistant text: its final statement. */
function finalText(t: string): string {
  const paras = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras.slice(-2).join(" ").replace(/\s+/g, " ").slice(-CONTEXT_MAX);
}

export function scoreOwnerText(text: string): { score: number; kind: CandidateKind } | undefined {
  const t = text.trim();
  if (!t || t.length > MAX_OWNER_LEN || APPROVAL.test(t)) return undefined;
  let score = 0;
  for (const r of RULES) if (r.re.test(t)) score += r.weight;
  if (score === 0) return undefined;
  // Short follow-up right after an assistant change: more likely a correction.
  if (t.length <= 160) score += 0.15;
  // Long messages dilute the signal.
  if (t.length > 600) score -= 0.2;
  score = Math.max(0, Math.min(1, score));
  if (score < 0.2) return undefined;
  const kind: CandidateKind = STANDING.test(t) ? "standing-rule" : PREFERENCE.test(t) ? "preference" : "correction";
  return { score: Math.round(score * 100) / 100, kind };
}

/** Owner turns that follow an assistant turn and look like a correction or redirect. */
export function findCorrections(turns: Turn[]): Candidate[] {
  const out: Candidate[] = [];
  let prev: Turn | undefined;
  for (const t of turns) {
    if (t.role === "assistant") {
      prev = t; // keeps the last assistant turn before the owner speaks
      continue;
    }
    if (prev && prev.session === t.session) {
      const s = scoreOwnerText(t.text);
      if (s) {
        out.push({
          session: t.session,
          ts: t.ts,
          context: finalText(prev.text),
          owner: t.text.trim().slice(0, OWNER_MAX),
          kind: s.kind,
          score: s.score,
        });
      }
    }
    prev = undefined;
  }
  return out;
}
