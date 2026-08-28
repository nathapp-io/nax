#!/usr/bin/env bun
/**
 * Issue #986 — aggregate adversarial structural counterfactual telemetry.
 *
 * Walks .nax/review-audit/**\/*.json (or a path passed as argv[2]),
 * computes the metrics table specified in the issue, and prints to stdout.
 *
 * Skips entries with reviewer != "adversarial" and entries that have no
 * adversarialDropAnalysis / adversarialAcceptAnalysis fields. Excludes
 * entries with diffAvailable === false from percentage calculations
 * (the fileInDiff axis is biased toward false in those records).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DROP_CODES = [
  "ac_quote_not_substring",
  "ac_quote_does_not_constrain_locus",
  "missing_ac_quote",
  "ac_index_out_of_range",
] as const;

const SUBSTRING_FRAGILITY_CODES: ReadonlySet<string> = new Set([
  "ac_quote_not_substring",
  "ac_quote_does_not_constrain_locus",
]);

interface Counterfactual {
  acIndexInRange: boolean;
  categoryBlocking: boolean;
  fileInDiff: boolean;
  wouldSurviveStructural: boolean;
}

interface DropAnalysis {
  dropCode: string;
  rawCategory: string;
  counterfactual: Counterfactual;
}

interface AcceptAnalysis {
  rawCategory: string;
  counterfactual: Counterfactual;
}

interface AuditFile {
  reviewer: string;
  diffAvailable: boolean | null;
  adversarialDropAnalysis: DropAnalysis[] | null;
  adversarialAcceptAnalysis: AcceptAnalysis[] | null;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(path, out);
    else if (name.endsWith(".json")) out.push(path);
  }
  return out;
}

function loadAudit(path: string): AuditFile | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AuditFile>;
    if (parsed.reviewer !== "adversarial") return null;
    return {
      reviewer: parsed.reviewer,
      diffAvailable: parsed.diffAvailable ?? null,
      adversarialDropAnalysis: parsed.adversarialDropAnalysis ?? null,
      adversarialAcceptAnalysis: parsed.adversarialAcceptAnalysis ?? null,
    };
  } catch {
    return null;
  }
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "n/a";
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function main(): void {
  const root = process.argv[2] ?? ".nax/review-audit";
  const files = walk(root);

  let totalReviews = 0;
  let totalDrops = 0;
  let totalDropsWithDiff = 0;
  let dropsSurviveStructuralWithDiff = 0;
  let dropsNotSurviveStructuralWithDiff = 0;
  const dropsByCode = new Map<string, number>();
  const dropCrosstab = new Map<string, { survive: number; notSurvive: number }>();
  let totalAccepts = 0;
  let totalAcceptsWithDiff = 0;
  let acceptsSurviveStructural = 0;
  let acceptsNotSurviveStructural = 0;
  const acceptsNotSurviveCategories = new Map<string, number>();
  let entriesNoDiff = 0;
  let promptComplianceFailures = 0;

  for (const path of files) {
    const audit = loadAudit(path);
    if (!audit) continue;
    if (audit.adversarialDropAnalysis === null && audit.adversarialAcceptAnalysis === null) continue;

    totalReviews += 1;
    // null (pre-#986 entries or failOpen/looksLikeFail paths) is treated the same as false:
    // both mean "diff file list was unavailable, exclude from % calculations".
    const diffOk = audit.diffAvailable === true;
    if (!diffOk) entriesNoDiff += 1;

    for (const drop of audit.adversarialDropAnalysis ?? []) {
      totalDrops += 1;
      dropsByCode.set(drop.dropCode, (dropsByCode.get(drop.dropCode) ?? 0) + 1);
      if (!diffOk) continue;
      totalDropsWithDiff += 1;
      if (!drop.counterfactual.fileInDiff && SUBSTRING_FRAGILITY_CODES.has(drop.dropCode)) {
        promptComplianceFailures += 1;
      }
      const survive = drop.counterfactual.wouldSurviveStructural;
      if (survive) dropsSurviveStructuralWithDiff += 1;
      else dropsNotSurviveStructuralWithDiff += 1;

      const bucket = dropCrosstab.get(drop.dropCode) ?? { survive: 0, notSurvive: 0 };
      if (survive) bucket.survive += 1;
      else bucket.notSurvive += 1;
      dropCrosstab.set(drop.dropCode, bucket);
    }

    for (const accept of audit.adversarialAcceptAnalysis ?? []) {
      totalAccepts += 1;
      if (!diffOk) continue;
      totalAcceptsWithDiff += 1;
      if (accept.counterfactual.wouldSurviveStructural) acceptsSurviveStructural += 1;
      else {
        acceptsNotSurviveStructural += 1;
        acceptsNotSurviveCategories.set(
          accept.rawCategory,
          (acceptsNotSurviveCategories.get(accept.rawCategory) ?? 0) + 1,
        );
      }
    }
  }

  const lines: string[] = [];
  lines.push(`Total adversarial reviews:        ${totalReviews}`);
  lines.push(`Entries excluded (no diff):       ${entriesNoDiff}`);
  lines.push(`Total drops:                      ${totalDrops}`);
  lines.push("Drops by code:");
  for (const code of DROP_CODES) {
    const count = dropsByCode.get(code) ?? 0;
    lines.push(`  ${code}: ${count} (${pct(count, totalDrops)})`);
  }
  lines.push("");
  lines.push(`Drops with diff available:        ${totalDropsWithDiff}`);
  lines.push("Drops by counterfactual (diff-available only):");
  lines.push(`  Would survive structural:        ${pct(dropsSurviveStructuralWithDiff, totalDropsWithDiff)}`);
  lines.push(`  Would NOT survive structural:    ${pct(dropsNotSurviveStructuralWithDiff, totalDropsWithDiff)}`);
  lines.push("");
  lines.push("Drop-cause crosstab (would-survive-structural × dropCode, diff-available only):");
  for (const code of DROP_CODES) {
    const bucket = dropCrosstab.get(code);
    if (!bucket) continue;
    lines.push(`  ${code} & survive:           ${bucket.survive}  ← would have been kept by structural-only`);
    lines.push(`  ${code} & NOT-survive:       ${bucket.notSurvive}`);
  }
  lines.push("");
  lines.push(`Total accepted blocking findings: ${totalAccepts}`);
  lines.push(`Accepts with diff available:      ${totalAcceptsWithDiff}`);
  lines.push("Accepted by counterfactual (diff-available only):");
  lines.push(`  Would survive structural:        ${pct(acceptsSurviveStructural, totalAcceptsWithDiff)}`);
  lines.push(
    `  Would NOT survive structural:    ${pct(acceptsNotSurviveStructural, totalAcceptsWithDiff)}  ← over-rejection risk if we replaced`,
  );
  lines.push("");
  lines.push("Categories of accepted findings that would NOT survive structural:");
  if (acceptsNotSurviveCategories.size === 0) {
    lines.push("  (none)");
  } else {
    for (const [cat, n] of [...acceptsNotSurviveCategories.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${cat}: ${n}`);
    }
  }
  lines.push("");
  lines.push("Decision-gate inputs:");
  const fragilityTotalDrops =
    (dropCrosstab.get("ac_quote_not_substring")?.notSurvive ?? 0) +
    (dropCrosstab.get("ac_quote_not_substring")?.survive ?? 0) +
    (dropCrosstab.get("ac_quote_does_not_constrain_locus")?.notSurvive ?? 0) +
    (dropCrosstab.get("ac_quote_does_not_constrain_locus")?.survive ?? 0);
  const fragilityNotSurvive =
    (dropCrosstab.get("ac_quote_not_substring")?.notSurvive ?? 0) +
    (dropCrosstab.get("ac_quote_does_not_constrain_locus")?.notSurvive ?? 0);
  lines.push(`  Substring-fragility drops (diff-available): ${fragilityTotalDrops}`);
  lines.push(
    `  ...of which NOT-survive structural:         ${pct(fragilityNotSurvive, fragilityTotalDrops)} → drives keep/refine/replace`,
  );
  lines.push("");
  lines.push(`Prompt-compliance proxy: ${promptComplianceFailures} substring-fragility drops had fileInDiff=false`);
  lines.push(`  (these are reviewer scope-violation findings — fixable in the prompt, not the validator)`);
  lines.push("");
  lines.push(
    `Decision gate trigger: N >= 50 distinct drops. Current: ${totalDrops} drop(s) total, ${totalDropsWithDiff} with diff.`,
  );

  console.log(lines.join("\n"));
}

main();
