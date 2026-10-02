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
 * The baseline records, per file, each over-limit function's score under a
 * label: the text Biome's diagnostic span covers — the function's name (`run`,
 * `#priv`, `["key"]`), `function` for an anonymous function expression, `=>`
 * for an anonymous arrow — plus `#2`, `#3`… for a repeat of the same label in
 * one file, in source order. Keyed by label, never by line, so ordinary edits
 * above a function do not churn it. A file passes when:
 *   - No file outside the baseline has an over-limit function.
 *   - No baselined file has an over-limit function under a label the baseline
 *     does not record (a helper split out of a baselined function is new code
 *     and must meet the limit).
 *   - No baselined function scores higher than its recorded score.
 *   - A baselined file that improved MUST be lowered, so the slack cannot be
 *     re-spent by a later change.
 *
 * Known blind spots:
 *   - A repeated label in one file is told apart only by source order. That
 *     covers anonymous arrows (`=>`), anonymous function expressions
 *     (`function`) and same-named methods (`run` on two classes). If one is
 *     fixed and a different function with the same label lands at or under a
 *     recorded score, the file reads as improved.
 *   - Biome does not score getters or setters at all, so logic moved into an
 *     accessor escapes both this gate and biome.json's cap.
 *   - Renaming a baselined function (or its file) reads as a new function. That
 *     fails safe: move the entry by hand in the same commit.
 *
 * Suppressions: a `biome-ignore` listing any selector that covers this rule
 * (the rule itself, `lint/complexity`, or bare `lint`, in a comment of one or
 * several rules) hides the function from Biome entirely, so this check fails
 * on any such comment in the scanned directories.
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
 *   bun scripts/check-complexity.ts --init-baseline   # write a baseline when none exists yet
 *   bun scripts/check-complexity.ts --list            # print every over-limit function
 *   --baseline=<path>                                 # use another baseline file (tests)
 *
 * Exit codes:
 *   0 — every file is within its baseline
 *   1 — a new/grown violation, a suppression, a baseline that must be lowered,
 *       an unreadable baseline, or a biome failure
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { gateBaselinePath, gatePackageRoot } from "./lib/package-root";

const ROOT = gatePackageRoot(import.meta.dir);
const DEFAULT_BASELINE_FILE = gateBaselinePath(ROOT, "complexity-baseline.json");
const RULE = "complexity/noExcessiveCognitiveComplexity";
/** Directories this package has; packages/nax-agent has no bin/ or scripts sources. */
const SCAN_DIRS = ["src/", "bin/", "test/", "scripts/"].filter((dir) => existsSync(join(ROOT, dir)));
const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

export const STRICT_LIMIT = 20;

/** An anonymous arrow's label: Biome points at its `=>` token, not a name. */
export const ARROW_LABEL = "=>";

export interface Score {
  file: string;
  score: number;
  /** The function's name, or ARROW_LABEL. Not yet unique within the file. */
  label: string;
  line: number;
  column: number;
}

/** Function label -> score. */
export type FunctionScores = Record<string, number>;

/** Relative path -> its over-limit functions. */
export type ScoresByFile = Record<string, FunctionScores>;

export interface Comparison {
  added: { file: string; scores: FunctionScores }[];
  grown: { file: string; scores: FunctionScores; baseline: FunctionScores }[];
  lowerable: string[];
}

interface Position {
  line?: number;
  column?: number;
}

interface Diagnostic {
  severity?: string;
  category?: string;
  message?: string;
  location?: { path?: string; start?: Position; end?: Position };
}

interface BiomeReport {
  summary?: { errors?: number; changed?: number; unchanged?: number };
  diagnostics?: Diagnostic[];
}

export type SourceReader = (file: string) => string;

const SCORE_RE = /complexity of (\d+)/;
const readRepoSource: SourceReader = (file) => readFileSync(resolve(ROOT, file), "utf8");

/**
 * The text Biome's span covers: normally the function's name (`run`, `#priv`,
 * `["computed"]`, `"str-name"`), `function` for an anonymous function
 * expression, or `=>` for an anonymous arrow. Biome counts columns in code
 * points, so the line is sliced by code point, not by UTF-16 unit.
 */
export function labelAt(source: string, start: Required<Position>, end: Required<Position>): string {
  const line = source.split("\n")[start.line - 1] ?? "";
  const text =
    start.line === end.line
      ? Array.from(line)
          .slice(start.column - 1, end.column - 1)
          .join("")
          .trim()
      : "";
  if (text === "")
    throw new Error(`cannot label the function at ${start.line}:${start.column} (empty or multi-line span)`);
  return text;
}

function readScore(d: Diagnostic, readSource: SourceReader): Score {
  const match = SCORE_RE.exec(d.message ?? "");
  const { path, start, end } = d.location ?? {};
  if (!match || !path || start?.line === undefined || start.column === undefined) {
    throw new Error(`cannot read a complexity score from biome diagnostic: ${JSON.stringify(d)}`);
  }
  if (end?.line === undefined || end.column === undefined) {
    throw new Error(`biome diagnostic has no span end: ${JSON.stringify(d)}`);
  }
  const from = { line: start.line, column: start.column };
  try {
    const label = labelAt(readSource(path), from, { line: end.line, column: end.column });
    return { file: path, score: Number(match[1]), label, ...from };
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Reads the complexity scores, and refuses a report it cannot vouch for.
 *
 * A file biome fails to parse or read produces an error of another category and
 * no complexity findings, so trusting only the complexity rows would under-count
 * and could let a new violation through. Every error in the summary must be a
 * complexity finding this function actually read. And a report that scanned
 * no files is not a clean tree: an exclusion matched all of it (#2306).
 */
export function parseScores(report: BiomeReport, readSource: SourceReader = readRepoSource): Score[] {
  if (!Array.isArray(report.diagnostics)) {
    throw new Error("biome report has no diagnostics array — reporter format changed?");
  }
  if (typeof report.summary?.errors !== "number") {
    throw new Error("biome report has no summary error count to confirm the run");
  }
  if ((report.summary.changed ?? 0) + (report.summary.unchanged ?? 0) === 0) {
    throw new Error("biome scanned no files — does a files.includes exclusion match the whole checkout?");
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
  return errors.map((d) => readScore(d, readSource));
}

/** One file's functions, keyed by label in source order (`name`, `name#2`, …), highest score first. */
function keyFunctions(scores: Score[]): FunctionScores {
  const inSourceOrder = [...scores].sort((a, b) => a.line - b.line || a.column - b.column);
  const seen = new Map<string, number>();
  const keyed = inSourceOrder.map((s) => {
    const n = (seen.get(s.label) ?? 0) + 1;
    seen.set(s.label, n);
    return [n === 1 ? s.label : `${s.label}#${n}`, s.score] as const;
  });
  return Object.fromEntries([...keyed].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0])));
}

export function tallyByFile(scores: Score[]): ScoresByFile {
  const files = [...new Set(scores.map((s) => s.file))].sort(byCodePoint);
  return Object.fromEntries(files.map((file) => [file, keyFunctions(scores.filter((s) => s.file === file))]));
}

/** True when every current function is baselined at or above its score. */
function withinBaseline(current: FunctionScores, baseline: FunctionScores): boolean {
  return Object.entries(current).every(([label, score]) => score <= (baseline[label] ?? Number.NEGATIVE_INFINITY));
}

function sameScores(a: FunctionScores, b: FunctionScores): boolean {
  const labels = Object.keys(a);
  return labels.length === Object.keys(b).length && labels.every((label) => a[label] === b[label]);
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
      const scores = current[file] ?? {};
      return withinBaseline(scores, recorded) && !sameScores(scores, recorded);
    })
    .map(([file]) => file);
  return { added, grown, lowerable };
}

/** A biome-ignore comment's selector list: everything after the directive, up to its `:` explanation. */
const IGNORE_DIRECTIVE_RE = /biome-ignore(?:-all|-start)?\s+([^:\n]*?)\s*(?::|\*\/|$)/g;
/** One selector that covers this rule: the rule itself, its group, or all of `lint`, optionally with a `(value)`. */
const COVERING_SELECTOR_RE = /^lint(?:\/complexity(?:\/noExcessiveCognitiveComplexity)?)?(?:\(.*\))?$/;

/** True when any biome-ignore on the line lists a selector covering this rule (Biome accepts several per comment). */
function suppressesRule(text: string): boolean {
  return [...text.matchAll(IGNORE_DIRECTIVE_RE)].some((m) =>
    (m[1] ?? "").split(/\s+/).some((selector) => COVERING_SELECTOR_RE.test(selector)),
  );
}

/** `file:line` for every suppression of this rule in `source`. */
export function findSuppressions(file: string, source: string): string[] {
  return source.split("\n").flatMap((text, i) => (suppressesRule(text) ? [`${file}:${i + 1}`] : []));
}

function scanSuppressions(): string[] {
  const glob = new Bun.Glob(SOURCE_GLOB);
  return SCAN_DIRS.flatMap((dir) =>
    [...glob.scanSync({ cwd: join(ROOT, dir) })]
      .filter((rel) => !rel.includes("node_modules/"))
      .sort(byCodePoint)
      .flatMap((rel) => findSuppressions(`${dir}${rel}`, readRepoSource(`${dir}${rel}`))),
  );
}

interface RepoBiomeConfig {
  files?: unknown;
}

/**
 * The repo's includes without its `!` exclusions. From a --config-path outside
 * the repo, Biome matches those against the absolute path, so `!**\/.nax-wt/**`
 * would drop every file of a checkout that itself lives under `.nax-wt/` (#2306).
 * SCAN_DIRS already bounds the scan, and no worktree sits inside it.
 */
function withoutExclusions(files: unknown): string[] {
  const includes = typeof files === "object" && files !== null ? (files as { includes?: unknown }).includes : undefined;
  const patterns = Array.isArray(includes) ? includes.filter((p): p is string => typeof p === "string") : ["**"];
  return patterns.filter((p) => !p.startsWith("!"));
}

/** A config that runs only the complexity rule at `limit`, over the repo config's includes. */
export function buildStrictConfig(repoConfig: RepoBiomeConfig, limit: number) {
  return {
    files: { includes: withoutExclusions(repoConfig.files) },
    linter: {
      enabled: true,
      rules: {
        recommended: false,
        complexity: { noExcessiveCognitiveComplexity: { level: "error", options: { maxAllowedComplexity: limit } } },
      },
    },
  };
}

/**
 * The repo's own Biome. `bun x biome` without node_modules fetches the unrelated
 * npm package `biome` (an env-var manager), which exits 0 with no report.
 */
const BIOME_BIN = join(ROOT, "node_modules", ".bin", "biome");

/** Scores `dirs` under `root` with the repo's strict config. `root` is a parameter for tests. */
export function runBiome(root = ROOT, dirs = SCAN_DIRS): Score[] {
  if (!existsSync(BIOME_BIN)) throw new Error(`${BIOME_BIN} not found — run \`bun install\` first`);
  const repoConfig = JSON.parse(readFileSync(join(ROOT, "biome.json"), "utf8")) as RepoBiomeConfig;
  const configDir = mkdtempSync(join(tmpdir(), "nax-complexity-"));
  try {
    writeFileSync(join(configDir, "biome.json"), JSON.stringify(buildStrictConfig(repoConfig, STRICT_LIMIT)));
    const proc = Bun.spawnSync(
      [
        BIOME_BIN,
        "lint",
        `--config-path=${configDir}`,
        `--only=${RULE}`,
        "--max-diagnostics=none",
        "--reporter=json",
        ...dirs,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const stdout = proc.stdout.toString().trim();
    // 0 = no findings, 1 = findings. Anything else (a crash, a signal) is not a result.
    if ((proc.exitCode !== 0 && proc.exitCode !== 1) || !stdout.startsWith("{")) {
      throw new Error(`biome produced no JSON report (exit ${proc.exitCode}): ${proc.stderr.toString().trim()}`);
    }
    return parseScores(JSON.parse(stdout), (file) => readFileSync(resolve(root, file), "utf8"));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function isFunctionScores(value: unknown): value is FunctionScores {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((score) => typeof score === "number")
  );
}

/** null only when the file does not exist; a file that exists but cannot be read as a baseline throws. */
export function loadBaseline(path: string): ScoresByFile | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { byFile?: unknown };
  const byFile = parsed.byFile;
  if (typeof byFile !== "object" || byFile === null || !Object.values(byFile).every(isFunctionScores)) {
    throw new Error(`${path} is not a baseline: "byFile" must map each file to { label: score }`);
  }
  return byFile as ScoresByFile;
}

/** biome.json's formatter.lineWidth: a baseline row longer than this is expanded, one function per line. */
const BASELINE_LINE_WIDTH = 120;

/**
 * One line per file where it fits, so a refactor's baseline diff is one line per
 * file it touched. Laid out exactly as Biome formats JSON, so `lint:biome` passes
 * on the file this writes.
 */
function baselineRow(file: string, scores: FunctionScores): string {
  const entries = Object.entries(scores).map(([label, score]) => `${JSON.stringify(label)}: ${score}`);
  const oneLine = `    ${JSON.stringify(file)}: { ${entries.join(", ")} }`;
  if (oneLine.length <= BASELINE_LINE_WIDTH) return oneLine;
  return `    ${JSON.stringify(file)}: {\n${entries.map((e) => `      ${e}`).join(",\n")}\n    }`;
}

function saveBaseline(path: string, byFile: ScoresByFile) {
  const rows = Object.entries(byFile).map(([file, scores]) => baselineRow(file, scores));
  const header = `  "updatedAt": ${JSON.stringify(new Date().toISOString())},\n  "limit": ${STRICT_LIMIT},`;
  const body = rows.length === 0 ? "{}" : `{\n${rows.join(",\n")}\n  }`;
  writeFileSync(path, `{\n${header}\n  "byFile": ${body}\n}\n`);
}

const formatScores = (scores: FunctionScores) =>
  Object.entries(scores)
    .map(([label, score]) => `${label} ${score}`)
    .join(", ");

function reportFailure(result: Comparison) {
  const breached = result.added.length > 0 || result.grown.length > 0;
  const headline = breached ? "ratchet breached" : "baseline is stale";
  console.error(`ERROR: cognitive complexity ${headline} (limit ${STRICT_LIMIT}).`);
  if (result.added.length > 0) {
    console.error("\nFunctions over the limit in files with no baseline — simplify before merging:");
    for (const a of result.added) console.error(`  ${a.file}: ${formatScores(a.scores)}`);
  }
  if (result.grown.length > 0) {
    console.error("\nBaselined files that got worse (a new over-limit function, or a higher score):");
    for (const g of result.grown)
      console.error(`  ${g.file}: ${formatScores(g.scores)} (baseline ${formatScores(g.baseline)})`);
  }
  if (result.lowerable.length > 0) {
    console.error("\nBaselined files that improved — lock the gain in:");
    for (const f of result.lowerable) console.error(`  ${f}`);
    console.error("  bun run check:complexity:update");
  }
  console.error(`\nFind the functions with: bun scripts/check-complexity.ts --list`);
}

function failOnSuppressions() {
  const suppressions = scanSuppressions();
  if (suppressions.length === 0) return;
  console.error(`ERROR: ${suppressions.length} biome-ignore comment(s) hide ${RULE} from this check:`);
  for (const s of suppressions) console.error(`  ${s}`);
  console.error("\nSimplify the function instead; a baselined one belongs in the baseline, not in a comment.");
  process.exit(1);
}

function listScores(scores: Score[], fileCount: number) {
  for (const s of [...scores].sort((a, b) => b.score - a.score)) console.log(`${s.score}  ${s.file}  ${s.label}`);
  console.log(`\nTotal over ${STRICT_LIMIT}: ${scores.length} functions in ${fileCount} files`);
}

/** Baseline-file preconditions that need no scan — checked first so a doomed run skips the slow biome pass. */
function checkBaselinePresence(baselineFile: string, args: string[]) {
  if (args.includes("--list")) return;
  const exists = existsSync(baselineFile);
  if (args.includes("--init-baseline") && exists) {
    console.error(`ERROR: ${baselineFile} already exists; --init-baseline never overwrites a baseline.`);
    process.exit(1);
  }
  if (!args.includes("--init-baseline") && !exists) {
    console.error(`ERROR: ${baselineFile} missing. Create one with --init-baseline.`);
    process.exit(1);
  }
}

function initBaseline(baselineFile: string, current: ScoresByFile, count: number) {
  saveBaseline(baselineFile, current);
  console.log(`OK: baseline initialised with ${count} functions in ${Object.keys(current).length} files.`);
}

function updateBaseline(baselineFile: string, result: Comparison, current: ScoresByFile, count: number) {
  if (result.added.length > 0 || result.grown.length > 0) {
    reportFailure({ ...result, lowerable: [] });
    console.error("\nRefusing to update: the baseline only ever goes down.");
    process.exit(1);
  }
  saveBaseline(baselineFile, current);
  console.log(`OK: baseline lowered to ${count} functions in ${Object.keys(current).length} files.`);
}

function main() {
  const args = process.argv.slice(2);
  const baselineFile =
    args.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length) ?? DEFAULT_BASELINE_FILE;
  failOnSuppressions();
  checkBaselinePresence(baselineFile, args);
  const scores = runBiome();
  const current = tallyByFile(scores);

  if (args.includes("--list")) return listScores(scores, Object.keys(current).length);
  if (args.includes("--init-baseline")) return initBaseline(baselineFile, current, scores.length);

  const baseline = loadBaseline(baselineFile);
  if (!baseline) {
    console.error(`ERROR: ${baselineFile} missing. Create one with --init-baseline.`);
    process.exit(1);
  }

  const result = compareToBaseline(baseline, current);
  if (args.includes("--update-baseline")) return updateBaseline(baselineFile, result, current, scores.length);

  if (result.added.length > 0 || result.grown.length > 0 || result.lowerable.length > 0) {
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
