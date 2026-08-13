/**
 * `nax context` CLI commands
 */

import { existsSync } from "node:fs";
import chalk from "chalk";
import { loadContextManifests } from "../context/engine";
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
// `nax context effectiveness eval` — US-001 evaluation harness (stubs)
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
  readLabels: async (_path: string): Promise<string> => {
    // Implementer replaces with `Bun.file(path).text()` (or similar).
    // Stub: never invoked; the command stub short-circuits before this.
    throw new Error("not implemented");
  },
  log: (stage: string, level: "warn" | "error", message: string, data?: Record<string, unknown>): void => {
    // Use console for stub; implementer swaps to getLogger().
    const fn = level === "error" ? console.error : console.warn;
    fn(`[${stage}] ${message}`, data ?? "");
  },
};

/**
 * `nax context effectiveness eval [--labels <path>] [--json]` — stub.
 *
 * STUB: always returns -1 so every CLI-level AC fails. Implementer
 * replaces with: loadLabelSet → classifier (the real one from
 * effectiveness.ts once US-003 lands) → scoreEffectiveness → format →
 * exit 0/1/2 per the spec.
 */
export async function effectivenessEvalCommand(options: EffectivenessEvalOptions): Promise<number> {
  // Surface the option in stderr once so a real invocation is observable.
  _effectivenessEvalDeps.log("effectiveness-eval", "error", "not implemented", { labels: options.labels });
  return -1;
}

/** STUB: pure formatter for the per-signal table (AC10/AC11/AC12). */
export function formatEffectivenessReport(
  _report: import("../context/engine/effectiveness-eval").EvalReport,
): string[] {
  return ["not implemented"];
}

/** STUB: pure error-message formatter. */
export function formatEffectivenessError(reason: string, path?: string): string {
  return `not implemented: ${reason}${path ? ` (${path})` : ""}`;
}

/** Re-export errorMessage for downstream call sites that need a safe str. */
export { errorMessage };
