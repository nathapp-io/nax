/**
 * `nax context` CLI commands
 */

import chalk from "chalk";
import { loadContextManifests } from "../context/engine";
import type { StoredContextManifest } from "../context/engine/manifest-store";

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
