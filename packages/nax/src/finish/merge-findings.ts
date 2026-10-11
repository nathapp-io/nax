/**
 * A4 review-round merge (spec §5 steps 2-3): dedupe across both lenses, split
 * out judgment findings, and flag possible spec-vs-quality contradictions so
 * the fixer is never handed two opposing changes. Pure.
 */
import type { Finding, Severity } from "./types";

export interface Contradiction {
  spec: Finding;
  quality: Finding;
}

export interface MergedFindings {
  toFix: Finding[];
  judged: Finding[];
  contradictions: Contradiction[];
}

const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

const locKey = (f: Finding): string => `${f.file ?? ""}\u0000${f.line ?? ""}`;
const dupKey = (f: Finding): string => `${locKey(f)}\u0000${f.title.trim().toLowerCase()}`;

function dedupe(all: Finding[]): Finding[] {
  const kept = new Map<string, Finding>();
  for (const f of all) {
    const prev = kept.get(dupKey(f));
    if (!prev || RANK[f.severity] > RANK[prev.severity]) kept.set(dupKey(f), f);
  }
  return [...kept.values()];
}

function pairContradictions(spec: Finding[], quality: Finding[]): { pairs: Contradiction[]; used: Set<Finding> } {
  const used = new Set<Finding>();
  const pairs: Contradiction[] = [];
  for (const s of spec) {
    if (!s.file) continue;
    const q = quality.find((x) => x.file && !used.has(x) && locKey(x) === locKey(s));
    if (!q) continue;
    used.add(s);
    used.add(q);
    pairs.push({ spec: s, quality: q });
  }
  return { pairs, used };
}

export function mergeFindings(spec: Finding[], quality: Finding[]): MergedFindings {
  const unique = dedupe([...spec, ...quality]);
  const judged = unique.filter((f) => f.judgment);
  const plain = unique.filter((f) => !f.judgment);
  const plainSpec = plain.filter((f) => f.source === "spec");
  const plainQuality = plain.filter((f) => f.source !== "spec");
  const { pairs, used } = pairContradictions(plainSpec, plainQuality);
  const toFix = [...plainSpec, ...plainQuality].filter((f) => !used.has(f));
  return { toFix, judged, contradictions: pairs };
}
