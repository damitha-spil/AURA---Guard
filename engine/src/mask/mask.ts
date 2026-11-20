import { detectSecrets, detectSensitive } from "./detectors.ts";
import type { DictionaryTerm, Span } from "./detectors.ts";

export interface MaskResult {
  ok: boolean; // false: a secret was found and the call must not go out
  text: string;
  blocked: { kind: string; count: number }[];
  replaced: { kind: string; count: number }[];
  map: Map<string, string>; // placeholder -> original, memory only
}

/** Longest and most severe span wins; ties go to the earlier one. */
function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "secret" ? -1 : 1;
    // A specific detector beats the generic randomness guess over the same text.
    const wa = a.kind === "HIGH_ENTROPY" ? 1 : 0;
    const wb = b.kind === "HIGH_ENTROPY" ? 1 : 0;
    if (wa !== wb) return wa - wb;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    return lb - la || a.start - b.start;
  });
  const kept: Span[] = [];
  for (const s of sorted) {
    if (s.end <= s.start) continue;
    if (kept.some((k) => s.start < k.end && k.start < s.end)) continue;
    kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function tally(counts: Map<string, number>): { kind: string; count: number }[] {
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

export function maskOutgoing(
  text: string,
  opts: { dictionary?: DictionaryTerm[] } = {},
): MaskResult {
  const spans = resolveOverlaps([...detectSecrets(text), ...detectSensitive(text, opts.dictionary ?? [])]);
  const blocked = new Map<string, number>();
  const replaced = new Map<string, number>();
  const map = new Map<string, string>();
  const byValue = new Map<string, string>(); // "KIND\0lowercased value" -> placeholder
  const perKind = new Map<string, number>();

  let out = "";
  let pos = 0;
  for (const s of spans) {
    out += text.slice(pos, s.start);
    const original = text.slice(s.start, s.end);
    if (s.severity === "secret") {
      out += `[SECRET_${s.kind}]`;
      blocked.set(s.kind, (blocked.get(s.kind) ?? 0) + 1);
    } else {
      const key = `${s.kind}\0${original.toLowerCase()}`;
      let ph = byValue.get(key);
      if (ph === undefined) {
        const n = (perKind.get(s.kind) ?? 0) + 1;
        perKind.set(s.kind, n);
        ph = `${s.kind}_${String(n).padStart(2, "0")}`;
        byValue.set(key, ph);
        map.set(ph, original);
      }
      out += ph;
      replaced.set(s.kind, (replaced.get(s.kind) ?? 0) + 1);
    }
    pos = s.end;
  }
  out += text.slice(pos);

  return { ok: blocked.size === 0, text: out, blocked: tally(blocked), replaced: tally(replaced), map };
}

/** Puts original values back into a model answer. Secrets are never in the map. */
export function unmask(text: string, map: Map<string, string>): string {
  if (map.size === 0) return text;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alt})(?![A-Za-z0-9_])`, "g");
  return text.replace(re, (m) => map.get(m) ?? m);
}
