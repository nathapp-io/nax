#!/usr/bin/env bun
/**
 * Adversarial recurrence-demotion — coverage-gap telemetry (Phase 0).
 *
 * PR #1337 shipped recurrence-demotion: an adversarial "error" finding that
 * recurs past `maxBlockingRounds` (default 2) is auto-demoted to advisory and
 * tagged `meta.coverageGap: true`. Demoted findings are the Phase-0 telemetry
 * that gates any Phase-1 work (docs/findings/2026-07-17-adversarial-review-
 * goalpost-gating.md §8.6/§13): are we demoting genuinely out-of-scope opinions
 * (correct — Phase 0 working), or dropping real in-scope defects (the signal to
 * build Phase 1 — commit-the-failing-test materialization)?
 *
 * This script walks <root>/<project>/review-audit/<feature>/*.json adversarial
 * records, extracts every `advisoryFindings[]` entry with `meta.coverageGap ===
 * true`, groups them per story, and prints:
 *   - per-story coverage-gap demotion counts
 *   - the distinct demoted findings (file, category, message) to eyeball for
 *     in-scope-vs-out-of-scope — the human judgement the gate needs
 *   - aggregate totals + the nax build(s) that produced the records (§8.8)
 *
 * Usage:
 *   bun scripts/analyze-coverage-gap.ts [root] [--since YYYY-MM-DD] [--project p,q] [--by-run]
 *
 *   root       directory containing per-project audit trees (default: ~/.nax)
 *   --since    only include records with mtime >= this date (default: none)
 *   --project  comma-separated project names to include (default: all dirs)
 *   --by-run   group per (project, run, feature, story) instead of merging a
 *              story's demotions across re-runs
 *
 * Example:
 *   bun scripts/analyze-coverage-gap.ts ~/.nax --since 2026-07-17 --project nathapp-nestjs-platform
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

interface AdvisoryFinding {
  file?: string | null;
  line?: number | null;
  category?: string | null;
  message?: string | null;
  severity?: string | null;
  meta?: { coverageGap?: boolean } | null;
}

interface AuditRecord {
  reviewer?: string;
  timestamp?: string;
  runId?: string | null;
  featureName?: string | null;
  storyId?: string | null;
  naxVersion?: string | null;
  naxCommit?: string | null;
  advisoryFindings?: AdvisoryFinding[] | null;
}

interface Demotion {
  file: string;
  category: string;
  message: string;
}

interface StoryStats {
  project: string;
  run: string;
  feature: string;
  story: string;
  records: number;
  demotions: number; // total coverage-gap tags across this story's records
  distinct: Map<string, { demotion: Demotion; rounds: number }>; // fingerprint -> occurrences
  builds: Set<string>; // naxVersion (naxCommit) that produced the records
}

/** Stable identity for a demoted finding (mirrors the runtime fingerprint intent: no line). */
function demotionId(f: AdvisoryFinding): string {
  const file = (f.file ?? "").replace(/\\/g, "/");
  const msg = (f.message ?? "").replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 48);
  return `${file}|${f.category ?? ""}|${msg}`;
}

function coverageGapFindings(rec: AuditRecord): AdvisoryFinding[] {
  return (rec.advisoryFindings ?? []).filter((f): f is AdvisoryFinding => Boolean(f) && f.meta?.coverageGap === true);
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
  const groups = new Map<string, StoryStats>();
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
      const gaps = coverageGapFindings(rec);
      if (gaps.length === 0) continue;

      const runSeg = byRun ? (rec.runId ?? "?") : "";
      const key = `${project}|${runSeg}|${rec.featureName ?? "?"}|${rec.storyId ?? "?"}`;
      const s =
        groups.get(key) ??
        ({
          project,
          run: runSeg,
          feature: rec.featureName ?? "?",
          story: rec.storyId ?? "?",
          records: 0,
          demotions: 0,
          distinct: new Map(),
          builds: new Set(),
        } satisfies StoryStats);
      s.records += 1;
      s.demotions += gaps.length;
      s.builds.add(`${rec.naxVersion ?? "?"}${rec.naxCommit ? ` (${rec.naxCommit})` : ""}`);
      for (const g of gaps) {
        const id = demotionId(g);
        const existing = s.distinct.get(id);
        if (existing) existing.rounds += 1;
        else
          s.distinct.set(id, {
            demotion: { file: g.file ?? "?", category: g.category ?? "?", message: (g.message ?? "").slice(0, 100) },
            rounds: 1,
          });
      }
      groups.set(key, s);
    }
  }
  return [...groups.values()];
}

function report(stats: StoryStats[]): void {
  if (stats.length === 0) {
    console.log(
      "No coverage-gap demotions found (no adversarial audit records with meta.coverageGap===true matched the filters).",
    );
    console.log(
      "Note: only runs made against nax with PR #1337 emit this tag — check the build column once records appear.",
    );
    return;
  }

  const totalDemotions = stats.reduce((a, s) => a + s.demotions, 0);
  const builds = new Set<string>();
  for (const s of stats) for (const b of s.builds) builds.add(b);

  console.log("=== coverage-gap demotions per story ===");
  for (const s of [...stats].sort((a, b) => b.demotions - a.demotions)) {
    const runSuffix = s.run ? ` (run ${s.run})` : "";
    console.log(
      `\n  ${s.project}/${s.feature} ${s.story}${runSuffix} — ${s.demotions} demotion(s) across ${s.records} record(s)`,
    );
    for (const { demotion, rounds } of [...s.distinct.values()].sort((a, b) => b.rounds - a.rounds)) {
      console.log(`    x${rounds}  ${demotion.file}  [${demotion.category}]  ${demotion.message}`);
    }
  }

  console.log("\n=== aggregate ===");
  console.log(`  stories with demotions: ${stats.length}`);
  console.log(`  total demotions:        ${totalDemotions}`);
  console.log(`  distinct demoted findings: ${stats.reduce((a, s) => a + s.distinct.size, 0)}`);
  console.log(`  nax build(s):           ${[...builds].join(", ")}`);

  console.log("\n=== how to read this (the Phase-1 gate) ===");
  console.log("  For each distinct demoted finding above, judge against the story's acceptance criteria:");
  console.log("   - Genuinely BEYOND the ACs (a production-hardening opinion the ACs never stated)");
  console.log("       -> correct demotion. Phase 0 is doing its job; no Phase 1 needed.");
  console.log("   - A REAL in-scope defect the ACs required and a green test should have caught");
  console.log("       -> wrong demotion. This is the signal to build Phase 1 (commit-the-failing-test");
  console.log("          materialization + pause-for-human). See the findings report §8.6/§13.");
}

report(collectStats(parseArgs(process.argv.slice(2))));
