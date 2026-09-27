#!/usr/bin/env bun
/**
 * Ratchet check: cognitive complexity per function, at a strict limit.
 *
 * biome.json's `noExcessiveCognitiveComplexity` sat at 176 — just above the
 * worst function in the repo — so it constrained nothing: a new 170-point
 * function passed. Lowering it directly would fail ~255 existing functions
 * across ~220 files, and Biome's only per-site escape is an inline
 * `biome-ignore` comment, which would have to be stamped into every one of
 * those files. So the strict limit lives here instead, with the existing
 * offenders recorded in ONE baseline file rather than in the source.
 *
 * The baseline records, per file, the scores of its over-limit functions
 * (highest first). Keyed by file and score, never by line, so ordinary edits
 * above a function do not churn it. A file passes when its current scores are
 * pointwise no worse than its baseline:
 *   - No file outside the baseline may have an over-limit function.
 *   - No baselined file may gain an over-limit function (a helper split out of
 *     a baselined function is new code and must meet the limit).
 *   - No baselined function may get worse.
 *   - A baselined file that improved MUST be lowered, so the slack cannot be
 *     re-spent by a later change.
 *
 * Known blind spot, accepted for line-independence: scores are compared by
 * rank, not by function identity. If a file's baselined function is fixed and
 * a different new function lands on exactly the same score, the file reads as
 * unchanged. Any other combination is caught.
 *
 * `--update-baseline` only ever lowers: it refuses while any file is new or
 * grown. Raising the baseline is a deliberate hand edit, visible in review.
 *
 * biome.json keeps a loose hard cap for editor feedback; this gate is the one
 * that holds new code to STRICT_LIMIT.
 *
 * Usage:
 *   bun scripts/check-complexity.ts                   # check (CI mode)
 *   bun scripts/check-complexity.ts --update-baseline # lower the baseline after a refactor
 *   bun scripts/check-complexity.ts --list            # print every over-limit function
 *   --baseline=<path>                                 # use another baseline file (tests)
 *
 * Exit codes:
 *   0 — every file is within its baseline
 *   1 — a new/grown violation, a baseline that must be lowered, or a biome failure
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byCodePoint } from "../src/utils/sort";

const ROOT = join(import.meta.dir, "..");
const DEFAULT_BASELINE_FILE = join(import.meta.dir, "baselines", "complexity-baseline.json");
const RULE = "complexity/noExcessiveCognitiveComplexity";
const SCAN_DIRS = ["src/", "bin/", "test/", "scripts/"];

export const STRICT_LIMIT = 20;

export interface Score {
  file: string;
  score: number;
}

/** Relative path -> scores of its over-limit functions, highest first. */
export type ScoresByFile = Record<string, number[]>;

export interface Comparison {
  added: { file: string; scores: number[] }[];
  grown: { file: string; scores: number[]; baseline: number[] }[];
  lowerable: string[];
}

interface Diagnostic {
  severity?: string;
  category?: string;
  message?: string;
  location?: { path?: string };
}

interface BiomeReport {
  summary?: { errors?: number };
  diagnostics?: Diagnostic[];
}

const SCORE_RE = /complexity of (\d+)/;

function readScore(d: Diagnostic): Score {
  const match = SCORE_RE.exec(d.message ?? "");
  if (!match || !d.location?.path) {
    throw new Error(`cannot read a complexity score from biome diagnostic: ${JSON.stringify(d)}`);
  }
  return { file: d.location.path, score: Number(match[1]) };
}

/**
 * Reads the complexity scores, and refuses a report it cannot vouch for.
 *
 * A file biome fails to parse or read produces an error of another category and
 * no complexity findings, so trusting only the complexity rows would under-count
 * and could let a new violation through. Every error in the summary must be a
 * complexity finding this function actually read.
 */
export function parseScores(report: BiomeReport): Score[] {
  if (!Array.isArray(report.diagnostics)) {
    throw new Error("biome report has no diagnostics array — reporter format changed?");
  }
  if (typeof report.summary?.errors !== "number") {
    throw new Error("biome report has no summary error count to confirm the run");
  }
  const errors = report.diagnostics.filter((d) => d.severity === "error");
  const foreign = errors.filter((d) => d.category !== `lint/${RULE}`);
  if (foreign.length > 0) {
    const first = foreign[0];
    throw new Error(
      `biome reported ${foreign.length} non-complexity error(s), first: ${first?.category} ${first?.message}`,
    );
  }
  if (report.summary.errors !== errors.length) {
    throw new Error(`biome summary counts ${report.summary.errors} errors but printed ${errors.length}`);
  }
  return errors.map(readScore);
}

export function tallyByFile(scores: Score[]): ScoresByFile {
  const files = [...new Set(scores.map((s) => s.file))].sort(byCodePoint);
  return Object.fromEntries(
    files.map((file) => [
      file,
      scores
        .filter((s) => s.file === file)
        .map((s) => s.score)
        .sort((a, b) => b - a),
    ]),
  );
}

/** True when every current score is <= the baseline score at the same rank, and there are no extra ones. */
function withinBaseline(current: number[], baseline: number[]): boolean {
  return current.length <= baseline.length && current.every((score, i) => score <= (baseline[i] ?? 0));
}

function sameScores(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((score, i) => score === b[i]);
}

export function compareToBaseline(baseline: ScoresByFile, current: ScoresByFile): Comparison {
  const added: Comparison["added"] = [];
  const grown: Comparison["grown"] = [];
  for (const [file, scores] of Object.entries(current)) {
    const recorded = baseline[file];
    if (recorded === undefined) added.push({ file, scores });
    else if (!withinBaseline(scores, recorded)) grown.push({ file, scores, baseline: recorded });
  }
  const lowerable = Object.entries(baseline)
    .filter(([file, recorded]) => {
      const scores = current[file] ?? [];
      return withinBaseline(scores, recorded) && !sameScores(scores, recorded);
    })
    .map(([file]) => file);
  return { added, grown, lowerable };
}

interface RepoBiomeConfig {
  files?: unknown;
}

/** A config that runs only the complexity rule at `limit`, over the same files as the repo config. */
export function buildStrictConfig(repoConfig: RepoBiomeConfig, limit: number) {
  return {
    files: repoConfig.files,
    linter: {
      enabled: true,
      rules: {
        recommended: false,
        complexity: { noExcessiveCognitiveComplexity: { level: "error", options: { maxAllowedComplexity: limit } } },
      },
    },
  };
}

function runBiome(): Score[] {
  const repoConfig = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8")) as RepoBiomeConfig;
  const configDir = mkdtempSync(join(tmpdir(), "nax-complexity-"));
  try {
    writeFileSync(join(configDir, "biome.json"), JSON.stringify(buildStrictConfig(repoConfig, STRICT_LIMIT)));
    const proc = Bun.spawnSync(
      [
        "bun",
        "x",
        "biome",
        "lint",
        `--config-path=${configDir}`,
        `--only=${RULE}`,
        "--max-diagnostics=none",
        "--reporter=json",
        ...SCAN_DIRS,
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = proc.stdout.toString().trim();
    // 0 = no findings, 1 = findings. Anything else (a crash, a signal) is not a result.
    if ((proc.exitCode !== 0 && proc.exitCode !== 1) || !stdout.startsWith("{")) {
      throw new Error(`biome produced no JSON report (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`);
    }
    return parseScores(JSON.parse(stdout));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function loadBaseline(path: string): ScoresByFile | null {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { byFile: ScoresByFile }).byFile;
  } catch {
    return null;
  }
}

/** One line per file, so a refactor's baseline diff is one line per file it touched. */
function saveBaseline(path: string, byFile: ScoresByFile) {
  const rows = Object.entries(byFile).map(([file, scores]) => `    ${JSON.stringify(file)}: [${scores.join(", ")}]`);
  const header = `  "updatedAt": ${JSON.stringify(new Date().toISOString())},\n  "limit": ${STRICT_LIMIT},`;
  writeFileSync(path, `{\n${header}\n  "byFile": {\n${rows.join(",\n")}\n  }\n}\n`);
}

function reportFailure(result: Comparison) {
  const breached = result.added.length > 0 || result.grown.length > 0;
  const headline = breached ? "ratchet breached" : "baseline is stale";
  console.error(`ERROR: cognitive complexity ${headline} (limit ${STRICT_LIMIT}).`);
  if (result.added.length > 0) {
    console.error("\nFunctions over the limit in files with no baseline — simplify before merging:");
    for (const a of result.added) console.error(`  ${a.file}: ${a.scores.join(", ")}`);
  }
  if (result.grown.length > 0) {
    console.error("\nBaselined files that got worse (a new over-limit function, or a higher score):");
    for (const g of result.grown)
      console.error(`  ${g.file}: ${g.scores.join(", ")} (baseline ${g.baseline.join(", ")})`);
  }
  if (result.lowerable.length > 0) {
    console.error("\nBaselined files that improved — lock the gain in:");
    for (const f of result.lowerable) console.error(`  ${f}`);
    console.error("  bun run check:complexity:update");
  }
  console.error(`\nFind the functions with: bun scripts/check-complexity.ts --list`);
}

function main() {
  const args = process.argv.slice(2);
  const baselineFile =
    args.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length) ?? DEFAULT_BASELINE_FILE;
  const scores = runBiome();
  const current = tallyByFile(scores);

  if (args.includes("--list")) {
    for (const s of [...scores].sort((a, b) => b.score - a.score)) console.log(`${s.score}  ${s.file}`);
    console.log(`\nTotal over ${STRICT_LIMIT}: ${scores.length} functions in ${Object.keys(current).length} files`);
    return;
  }

  const baseline = loadBaseline(baselineFile);
  if (!baseline) {
    if (args.includes("--init-baseline")) {
      saveBaseline(baselineFile, current);
      console.log(`OK: baseline initialised with ${scores.length} functions in ${Object.keys(current).length} files.`);
      return;
    }
    console.error(`ERROR: ${baselineFile} missing or unreadable.`);
    process.exit(1);
  }

  const result = compareToBaseline(baseline, current);
  const breached = result.added.length > 0 || result.grown.length > 0;

  if (args.includes("--update-baseline")) {
    if (breached) {
      reportFailure({ ...result, lowerable: [] });
      console.error("\nRefusing to update: the baseline only ever goes down.");
      process.exit(1);
    }
    saveBaseline(baselineFile, current);
    console.log(`OK: baseline lowered to ${scores.length} functions in ${Object.keys(current).length} files.`);
    return;
  }

  if (breached || result.lowerable.length > 0) {
    reportFailure(result);
    process.exit(1);
  }
  console.log(`OK: ${scores.length} baselined functions over ${STRICT_LIMIT} in ${Object.keys(current).length} files.`);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`ERROR: check-complexity could not measure: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
