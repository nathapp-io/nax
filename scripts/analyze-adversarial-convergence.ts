#!/usr/bin/env bun
/**
 * Issue #736 — adversarial review convergence / goalpost-moving telemetry.
 *
 * Closes the "Telemetry gate" task: verifies whether the prior-iterations
 * carry-forward fix (#757 + #972 Patches A/B) actually resolves the
 * goalpost-moving symptom — each adversarial round surfacing a *different*
 * set of blocking findings, never converging, exhausting rectification budget.
 *
 * Walks <root>/<project>/review-audit/<feature>/*.json adversarial records,
 * groups them into per-story round sequences (ordered by timestamp), and for
 * each story computes:
 *   - rounds        — number of adversarial review records
 *   - carried_over  — blocking findings re-flagged from the previous round
 *                     (identical file:line:category) → the carry-forward
 *                     re-flag mechanism firing on an unaddressed finding
 *   - new           — blocking findings not present in the previous round
 *   - final_pass    — passed verdict on the last round
 *
 * Healthy convergence: rounds bounded (mostly <=3), final_pass true, and a low
 * tail of >=4-round stories. Persistent goalpost-moving shows as a heavy tail
 * with carried_over === 0 and many `new` findings every round (the reviewer
 * keeps finding unrelated issues and never adjudicates priors).
 *
 * Usage:
 *   bun scripts/analyze-adversarial-convergence.ts [root] [--since YYYY-MM-DD] [--project p,q] [--by-run]
 *
 *   root       directory containing per-project audit trees (default: ~/.nax)
 *   --since    only include records with mtime >= this date (default: none)
 *   --project  comma-separated project names to include (default: all dirs)
 *   --by-run   group rounds per (project, run, feature, story) instead of the
 *              default (project, feature, story). The default merges a story's
 *              rounds across re-runs into one sequence ("how many times did this
 *              story bounce through adversarial review"); --by-run keeps each run
 *              separate ("how many rounds within a single run").
 *
 * Example (the #736 gate corpus):
 *   bun scripts/analyze-adversarial-convergence.ts ~/.nax --since 2026-05-11 --project nax,rs-stock
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

interface Finding {
  file?: string | null;
  line?: number | null;
  category?: string | null;
  ruleId?: string | null;
  message?: string | null;
  severity?: string | null;
}

interface AuditRecord {
  reviewer?: string;
  timestamp?: string;
  runId?: string | null;
  featureName?: string | null;
  storyId?: string | null;
  result?: { passed?: boolean; findings?: Finding[] | null } | null;
}

interface StoryStats {
  project: string;
  run: string;
  feature: string;
  story: string;
  rounds: number;
  carriedOver: number;
  newFindings: number;
  finalPass: boolean | null;
}

/** Stable identity for a finding across rounds. */
function findingId(f: Finding): string {
  if (f.file) return `${f.file}:${f.line ?? "?"}:${f.category ?? ""}`;
  return f.ruleId ?? (f.message ?? "").slice(0, 40);
}

function blockingIds(rec: AuditRecord): Set<string> {
  const findings = rec.result?.findings ?? [];
  return new Set(findings.filter((f): f is Finding => Boolean(f) && f.severity === "error").map(findingId));
}

function isAdversarial(path: string, rec: AuditRecord): boolean {
  return rec.reviewer === "adversarial" || basename(path).includes("adversarial");
}

function walkJson(dir: string, out: string[] = []): string[] {
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
    if (st.isDirectory()) walkJson(path, out);
    else if (name.endsWith(".json")) out.push(path);
  }
  return out;
}

interface Args {
  root: string;
  since: number;
  projects: string[] | null;
  byRun: boolean;
}

function parseArgs(argv: string[]): Args {
  let root = join(homedir(), ".nax");
  let since = 0;
  let projects: string[] | null = null;
  let byRun = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since") since = Date.parse(`${argv[++i]}T00:00:00Z`) / 1000;
    else if (a === "--project") projects = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--by-run") byRun = true;
    else positional.push(a);
  }
  if (positional[0]) root = positional[0];
  return { root, since, projects, byRun };
}

function collectStats(args: Args): StoryStats[] {
  const { root, since, projects, byRun } = args;
  // group key: project|[run|]feature|story -> timestamp -> record (dedupes filename-convention drift)
  const groups = new Map<string, Map<string, AuditRecord>>();
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root).filter((p) => {
      try {
        return statSync(join(root, p)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }

  for (const project of projectDirs) {
    if (projects && !projects.includes(project)) continue;
    const reviewAuditDir = join(root, project, "review-audit");
    for (const path of walkJson(reviewAuditDir)) {
      if (since && statSync(path).mtimeMs / 1000 < since) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(readFileSync(path, "utf8")) as AuditRecord;
      } catch {
        continue;
      }
      if (!isAdversarial(path, rec)) continue;
      // Run segment is empty in default mode so all re-runs of a story merge;
      // included in --by-run mode so each run stays a separate sequence.
      const runSeg = byRun ? (rec.runId ?? "?") : "";
      const key = `${project}|${runSeg}|${rec.featureName ?? "?"}|${rec.storyId ?? "?"}`;
      const byTs = groups.get(key) ?? new Map<string, AuditRecord>();
      byTs.set(rec.timestamp ?? path, rec);
      groups.set(key, byTs);
    }
  }

  const stats: StoryStats[] = [];
  for (const [key, byTs] of groups) {
    const [project, run, feature, story] = key.split("|");
    const rounds = [...byTs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, rec]) => rec);
    let prev = new Set<string>();
    let carriedOver = 0;
    let newFindings = 0;
    rounds.forEach((rec, i) => {
      const ids = blockingIds(rec);
      if (i > 0) {
        for (const id of ids) {
          if (prev.has(id)) carriedOver += 1;
          else newFindings += 1;
        }
      }
      prev = ids;
    });
    stats.push({
      project,
      run,
      feature,
      story,
      rounds: rounds.length,
      carriedOver,
      newFindings,
      finalPass: rounds[rounds.length - 1]?.result?.passed ?? null,
    });
  }
  return stats;
}

function report(stats: StoryStats[]): void {
  if (stats.length === 0) {
    console.log("No adversarial review records matched the filters.");
    return;
  }

  const dist = new Map<number, number>();
  for (const s of stats) dist.set(s.rounds, (dist.get(s.rounds) ?? 0) + 1);

  console.log("=== adversarial rounds-per-story distribution ===");
  let cumulative = 0;
  for (const [n, count] of [...dist.entries()].sort(([a], [b]) => a - b)) {
    cumulative += count;
    const pct = ((cumulative / stats.length) * 100).toFixed(0);
    console.log(`  ${n} round(s): ${count} stories  (<=${n}: ${pct}% cumulative)`);
  }

  const multi = stats.filter((s) => s.rounds > 1);
  const carried = stats.reduce((a, s) => a + s.carriedOver, 0);
  const passed = stats.filter((s) => s.finalPass === true).length;
  console.log("\n=== aggregate ===");
  console.log(`  stories:               ${stats.length}`);
  console.log(`  multi-round (>1):      ${multi.length}`);
  console.log(`  final-round PASS:      ${passed}/${stats.length}`);
  console.log(`  carry-forward re-flag: ${carried} findings re-flagged across all rounds`);

  const tail = stats.filter((s) => s.rounds >= 4).sort((a, b) => b.rounds - a.rounds);
  console.log(`\n=== stall tail (>=4 rounds — PR 3.3 candidates): ${tail.length} ===`);
  for (const s of tail) {
    const runSuffix = s.run ? ` (run ${s.run})` : "";
    console.log(
      `  ${s.project}/${s.feature} ${s.story}${runSuffix}: ${s.rounds} rounds, ` +
        `carried=${s.carriedOver} new=${s.newFindings} final_pass=${s.finalPass}`,
    );
  }
}

report(collectStats(parseArgs(process.argv.slice(2))));
