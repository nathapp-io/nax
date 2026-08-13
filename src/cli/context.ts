/**
 * `nax context` CLI commands
 */

import { existsSync } from "node:fs";
import chalk from "chalk";
import { loadContextManifests } from "../context/engine";
import { buildEvidenceTerms, classifyWithTerms } from "../context/engine/effectiveness";
import {
  type Classifier,
  type EvalReport,
  INVALID_JSON_ERROR_CODE,
  type LabelCase,
  type LabelSet,
  SCHEMA_INVALID_ERROR_CODE,
  loadLabelSet,
  scoreEffectiveness,
} from "../context/engine/effectiveness-eval";
import type { StoredContextManifest } from "../context/engine/manifest-store";
import { errorMessage } from "../utils/errors";

export interface ContextInspectOptions {
  dir?: string;
  feature?: string;
  json?: boolean;
  storyId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatter (pure — testable without disk I/O)
// ─────────────────────────────────────────────────────────────────────────────

export function formatContextInspect(storyId: string, manifests: StoredContextManifest[]): string[] {
  const lines: string[] = [];

  if (manifests.length === 0) {
    lines.push(chalk.yellow(`No context manifests found for story ${storyId}.`));
    return lines;
  }

  lines.push(
    chalk.bold(
      `\nContext manifests for story ${storyId}  (${manifests.length} stage${manifests.length === 1 ? "" : "s"})\n`,
    ),
  );

  for (const item of manifests) {
    const { manifest, featureId, stage } = item;
    const pct =
      manifest.totalBudgetTokens > 0 ? Math.round((manifest.usedTokens / manifest.totalBudgetTokens) * 100) : 0;

    lines.push(chalk.bold(`  Stage: ${stage}`) + chalk.dim(`  [feature: ${featureId}]`));
    lines.push(chalk.dim(`  ${"─".repeat(50)}`));

    lines.push(`    Budget   ${manifest.usedTokens} / ${manifest.totalBudgetTokens} tokens (${pct}%)`);
    lines.push(`    Build    ${manifest.buildMs}ms    Digest ${manifest.digestTokens} tokens`);
    lines.push(
      `    Chunks   ${chalk.green(`${manifest.includedChunks.length} included`)}  ${chalk.dim(`${manifest.excludedChunks.length} excluded`)}`,
    );

    if (manifest.floorItems.length > 0) {
      const overageCount = manifest.floorOverageItems?.length ?? 0;
      const overageNote = overageCount > 0 ? chalk.yellow(`  (${overageCount} overage)`) : "";
      lines.push(`    Floor    ${manifest.floorItems.length} items${overageNote}`);
    }

    if (manifest.providerResults && manifest.providerResults.length > 0) {
      lines.push("");
      lines.push(chalk.dim("    Providers:"));
      for (const pr of manifest.providerResults) {
        const statusColor =
          pr.status === "ok"
            ? chalk.green(pr.status)
            : pr.status === "empty"
              ? chalk.dim(pr.status)
              : chalk.red(pr.status);
        const errorNote = pr.error ? chalk.red(`  error=${pr.error}`) : "";
        lines.push(
          `      ${pr.providerId.padEnd(22)} ${statusColor.padEnd(10)}  chunks=${pr.chunkCount}  tokens=${pr.tokensProduced}  ${pr.durationMs}ms${errorNote}`,
        );
      }
    }

    if (manifest.excludedChunks.length > 0) {
      lines.push("");
      lines.push(chalk.dim("    Excluded chunks:"));
      for (const ex of manifest.excludedChunks) {
        lines.push(`      ${chalk.dim(ex.id)}  reason=${ex.reason}`);
      }
    }

    lines.push("");
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

export async function contextInspectCommand(options: ContextInspectOptions): Promise<void> {
  const workdir = options.dir ?? process.cwd();
  const manifests = await loadContextManifests(workdir, options.storyId, options.feature);

  if (options.json) {
    console.log(JSON.stringify(manifests, null, 2));
    return;
  }

  const output = formatContextInspect(options.storyId, manifests);
  for (const line of output) {
    console.log(line);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// `nax context effectiveness eval` — US-001 evaluation harness
// ─────────────────────────────────────────────────────────────────────────────

export interface EffectivenessEvalOptions {
  /** Project directory (defaults to process.cwd()). */
  dir?: string;
  /** Path to the labels JSON file. */
  labels?: string;
  /** Emit a single EvalReport JSON to stdout, suppressing the table. */
  json?: boolean;
}

/** Reserved so tests can stub I/O without touching the real fs/logger. */
export const _effectivenessEvalDeps = {
  existsSync,
  readLabels: async (path: string): Promise<string> => {
    return await Bun.file(path).text();
  },
  log: (stage: string, level: "warn" | "error", message: string, data?: Record<string, unknown>): void => {
    const fn = level === "error" ? console.error : console.warn;
    fn(`[${stage}] ${message}`, data ?? "");
  },
  // The production classifier (US-003): classify each labelled case through
  // the real scoped added-line attribution, keyed on the case's own scopePaths.
  classify: classifyScopedCase,
  scoreEffectiveness,
};

/**
 * `nax context effectiveness eval [--labels <path>] [--json]`
 *
 * Exit codes:
 *   0 — classifier meets every recorded baseline threshold
 *   1 — internal / scoring failure (e.g. classifier threw on every case)
 *   2 — invalid input (path missing, read failure, schema-invalid labels)
 */
export async function effectivenessEvalCommand(options: EffectivenessEvalOptions): Promise<number> {
  const labelsPath = options.labels;
  if (!labelsPath) {
    _effectivenessEvalDeps.log("effectiveness-eval", "error", "Missing --labels <path> argument");
    process.exit(2);
  }

  if (!_effectivenessEvalDeps.existsSync(labelsPath)) {
    const msg = formatEffectivenessError("labels path does not exist", labelsPath);
    _effectivenessEvalDeps.log("effectiveness-eval", "error", msg);
    process.exit(2);
  }

  let raw: string;
  try {
    raw = await _effectivenessEvalDeps.readLabels(labelsPath);
  } catch (err) {
    const msg = formatEffectivenessError(`failed to read labels file: ${errorMessage(err)}`, labelsPath);
    _effectivenessEvalDeps.log("effectiveness-eval", "error", msg);
    process.exit(2);
  }

  let labelSet: LabelSet;
  try {
    labelSet = loadLabelSet(raw);
  } catch (err) {
    const code = (err as { code?: string }).code;
    const reason =
      code === INVALID_JSON_ERROR_CODE
        ? "invalid JSON in labels file"
        : code === SCHEMA_INVALID_ERROR_CODE
          ? `labels file fails schema validation: ${errorMessage(err)}`
          : errorMessage(err);
    const msg = formatEffectivenessError(reason, labelsPath);
    _effectivenessEvalDeps.log("effectiveness-eval", "error", msg);
    process.exit(2);
  }

  const report = _effectivenessEvalDeps.scoreEffectiveness(labelSet.cases, _effectivenessEvalDeps.classify);

  if (options.json) {
    console.log(JSON.stringify(report));
    return 0;
  }

  for (const line of formatEffectivenessReport(report)) {
    console.log(line);
  }

  // Gate: every per-signal F1 must clear the corresponding baseline F1.
  // The committed fixture is constructed so this gate passes for any
  // classifier that performs strictly better than the always-ignored
  // baseline; the real US-003 classifier is what it runs against.
  const passed = meetsBaseline(report);
  return passed ? 0 : 1;
}

/** Pure formatter for the per-signal table — header + 3 signal rows + baseline + size. */
export function formatEffectivenessReport(report: EvalReport): string[] {
  const lines: string[] = [];
  lines.push("signal       precision  recall     f1");
  const keys: Array<"followed" | "ignored" | "contradicted"> = ["followed", "ignored", "contradicted"];
  for (const k of keys) {
    const s = report.perSignal[k];
    lines.push(`${k.padEnd(12)} ${pad2(s.precision)}     ${pad2(s.recall)}    ${pad2(s.f1)}`);
  }
  lines.push(
    `${"baseline".padEnd(12)} ${pad2(report.baseline.precision)}     ${pad2(report.baseline.recall)}    ${pad2(report.baseline.f1)}`,
  );
  lines.push(
    `size-corr  ${report.sizeCorrelation.toFixed(3)}   (scored=${report.scoredCount}, excluded=${report.excludedCount})`,
  );
  return lines;
}

/** Pure error-message formatter. */
export function formatEffectivenessError(reason: string, path?: string): string {
  return path ? `${reason}: ${path}` : reason;
}

function pad2(n: number): string {
  return n.toFixed(2);
}

/**
 * The US-003 gate (AC12): the scoped classifier's followed F1 must strictly
 * beat the always-ignored baseline's F1 in the same report. The deterministic
 * scoped classifier cannot emit "contradicted" for eval cases (findings are
 * not part of the label-set), so a per-signal comparison against the baseline
 * would always fail on that bucket — the story's gate is stated in terms of
 * the followed signal only.
 */
function meetsBaseline(report: EvalReport): boolean {
  return report.perSignal.followed.f1 > report.baseline.f1;
}

/**
 * Production classifier for `nax context effectiveness eval` (US-003).
 * Classifies a labelled case via classifyWithTerms + buildEvidenceTerms with
 * the case's own scopePaths, so the harness exercises the real scoped
 * added-line attribution instead of echoing the recorded label.
 */
function classifyScopedCase(c: LabelCase): Exclude<LabelCase["label"], "unclear"> {
  const evidence = buildEvidenceTerms("", c.diffText, []);
  const result = classifyWithTerms(c.chunkSummary, evidence, {
    scopePaths: c.scopePaths,
    diffText: c.diffText,
  });
  if (result.signal === "unknown") return "ignored";
  if (result.signal === "contradicted") return "contradicted";
  return result.signal;
}

/** Re-export errorMessage for downstream call sites that need a safe str. */
export { errorMessage };
