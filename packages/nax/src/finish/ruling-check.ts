/**
 * Finish B §3: does a review finding repeat an advisor ruling? Pure.
 *
 * A ruling binds by the finding's anchor file, across both lenses. The title only
 * decides exact (reuse, no call) versus near (ask the advisor, with the ruling as
 * evidence). A HIGH/CRITICAL finding or ruling is never reused without a call.
 */
import type { AdviceDecision } from "@/advisor";
import { dedupeKeyFor } from "@/advisor";
import type { MergedFindings } from "./merge-findings";
import type { Finding } from "./types";

export interface Ruling {
  id: string;
  action: "waive" | "supersede";
  anchor?: string;
  title?: string;
  legacyKey?: string;
  blocking: boolean;
  summary: string;
  decision?: AdviceDecision;
}

export type MatchLevel = "exact" | "near" | "none";

export interface RulingCheck {
  reuse: { finding: Finding; ruling: Ruling }[];
  near: { finding: Finding; rulings: Ruling[] }[];
  rest: Finding[];
}

const BLOCKING = new Set(["HIGH", "CRITICAL", "error", "critical"]);

export function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?:;,]+$/, "");
}

/** `phase|title|path-or-#hash`; a title may contain "|", so split on the first and last separator. */
function keyParts(key: string): { title?: string; anchor?: string } {
  const first = key.indexOf("|");
  const last = key.lastIndexOf("|");
  if (first < 0 || last <= first) return {};
  const tail = key.slice(last + 1);
  return { title: key.slice(first + 1, last), ...(tail !== "" && !tail.startsWith("#") ? { anchor: tail } : {}) };
}

function summaryOf(action: string, title: string | undefined, anchor: string | undefined, detail?: string): string {
  const head = `${action}: ${title ?? "finding"}${anchor ? ` (${anchor})` : ""}`;
  return detail ? `${head} — ${detail}` : head;
}

export function rulingFromDecision(d: AdviceDecision): Ruling | undefined {
  if (d.kind !== "finish-judgment") return undefined;
  const a = d.action;
  if (a.type !== "waive" && a.type !== "supersede") return undefined;
  const parts = d.dedupeKey ? keyParts(d.dedupeKey) : {};
  const anchor = d.anchorFile ?? parts.anchor;
  const title = d.rulingTitle ?? parts.title;
  return {
    id: d.id,
    action: a.type,
    ...(anchor ? { anchor } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(d.dedupeKey ? { legacyKey: d.dedupeKey } : {}),
    blocking: BLOCKING.has(d.findingSeverity ?? ""),
    summary: summaryOf(a.type, title, anchor, a.type === "waive" ? a.reason : a.newText),
    decision: d,
  };
}

export function rulingFromDropped(
  d: { finding: Finding; decisionId: string; action: "waive" | "supersede" },
  decision?: AdviceDecision,
): Ruling {
  const { finding } = d;
  const a = decision?.action;
  const detail = a?.type === "waive" ? a.reason : a?.type === "supersede" ? a.newText : undefined;
  return {
    id: d.decisionId,
    action: d.action,
    ...(finding.file ? { anchor: finding.file } : {}),
    title: finding.title,
    blocking: BLOCKING.has(finding.severity),
    summary: summaryOf(d.action, finding.title, finding.file, detail),
    ...(decision ? { decision } : {}),
  };
}

export function matchLevel(f: Finding, r: Ruling): MatchLevel {
  if (r.legacyKey !== undefined && dedupeKeyFor(f.source ?? "quality", f) === r.legacyKey) return "exact";
  if (!f.file || !r.anchor || f.file !== r.anchor) return "none";
  return r.title !== undefined && normTitle(r.title) === normTitle(f.title) ? "exact" : "near";
}

export function checkRulings(findings: Finding[], rulings: Ruling[]): RulingCheck {
  const newestFirst = [...rulings].reverse();
  const reuse: RulingCheck["reuse"] = [];
  const near: RulingCheck["near"] = [];
  const rest: Finding[] = [];
  for (const f of findings) {
    const exact = newestFirst.find((r) => matchLevel(f, r) === "exact");
    if (exact && !exact.blocking && !BLOCKING.has(f.severity)) {
      reuse.push({ finding: f, ruling: exact });
      continue;
    }
    const matching = newestFirst.filter((r) => matchLevel(f, r) !== "none");
    if (matching.length > 0) near.push({ finding: f, rulings: matching });
    else rest.push(f);
  }
  return { reuse, near, rest };
}

/** §3.4 step 2: every merged finding through the check; a contradiction with a matched side is dissolved. */
export function splitForRulings(
  merged: MergedFindings,
  rulings: Ruling[],
): { check: RulingCheck; merged: MergedFindings } {
  if (rulings.length === 0) return { check: { reuse: [], near: [], rest: [] }, merged };
  const sides = merged.contradictions.flatMap((c) => [c.spec, c.quality]);
  const check = checkRulings([...merged.toFix, ...merged.judged, ...sides], rulings);
  const free = new Set(check.rest);
  const kept = merged.contradictions.filter((c) => free.has(c.spec) && free.has(c.quality));
  const keptSides = new Set(kept.flatMap((c) => [c.spec, c.quality]));
  const loose = sides.filter((f) => free.has(f) && !keptSides.has(f));
  return {
    check,
    merged: {
      toFix: [...merged.toFix.filter((f) => free.has(f)), ...loose.filter((f) => !f.judgment)],
      judged: [...merged.judged.filter((f) => free.has(f)), ...loose.filter((f) => f.judgment)],
      contradictions: kept,
    },
  };
}
