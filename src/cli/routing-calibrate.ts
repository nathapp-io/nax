import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { DEFAULT_CONFIG } from "../config";
import type { NaxConfig } from "../config";
import { loadRunMetrics as _loadRunMetrics } from "../metrics";
import type { RunMetrics } from "../metrics";
import { projectInputDir, projectOutputDir } from "../runtime";
import { loadJsonFile, saveJsonFile } from "../utils/json-file";

import { computeBandStats, proposeAdjustments } from "../routing";
import type { CalibrationProposal, KeywordHint, TierAdjustment } from "../routing/calibrate";

export interface RoutingCalibrateOptions {
  apply?: boolean;
  json?: boolean;
  minSamples?: number;
  workdir?: string;
  outputDir?: string;
}

export interface RoutingCalibrateResult {
  proposal: CalibrationProposal;
  exitCode: number;
  wroteConfig?: boolean;
}

export interface RoutingCalibrateDeps {
  loadRunMetrics: (outputDir: string) => Promise<RunMetrics[]>;
  readConfig: (workdir: string) => Promise<NaxConfig | null>;
  writeConfig: (workdir: string, config: NaxConfig) => Promise<void>;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
}

export const _routingCalibrateDeps: RoutingCalibrateDeps = {
  loadRunMetrics: (outputDir: string) => _loadRunMetrics(outputDir),
  readConfig: async (workdir: string): Promise<NaxConfig | null> => {
    const candidatePath = join(projectInputDir(workdir), "config.json");
    if (!existsSync(candidatePath)) return null;
    const data = await loadJsonFile<NaxConfig>(candidatePath, "routing-calibrate");
    return data ?? null;
  },
  writeConfig: async (workdir: string, config: NaxConfig): Promise<void> => {
    const dir = projectInputDir(workdir);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, "config.json");
    await saveJsonFile(filePath, config, "routing-calibrate");
  },
  stdout: (msg: string): void => {
    process.stdout.write(`${msg}\n`);
  },
  stderr: (msg: string): void => {
    process.stderr.write(`${msg}\n`);
  },
};

function resolveOutputDir(workdir: string, override: string | undefined, prior: NaxConfig | null): string {
  if (override) return override;
  const key = prior?.name?.trim() || basename(workdir);
  return projectOutputDir(key, prior?.outputDir);
}

function mergeComplexityRouting(prior: Record<string, string>, adjustments: TierAdjustment[]): Record<string, string> {
  const merged: Record<string, string> = { ...prior };
  for (const adj of adjustments) {
    merged[adj.band] = adj.to;
  }
  return merged;
}

interface JsonView {
  adjustments: TierAdjustment[];
  keywordHints: KeywordHint[];
  skipped: CalibrationProposal["skipped"];
}

function buildJsonView(proposal: CalibrationProposal): JsonView {
  return {
    adjustments: proposal.adjustments,
    keywordHints: proposal.hints,
    skipped: proposal.skipped,
  };
}

function printHumanView(emit: (msg: string) => void, proposal: CalibrationProposal): void {
  emit(`[routing-calibrate] generated at ${proposal.generatedAt}`);
  for (const adj of proposal.adjustments) {
    emit(`  adjust ${adj.band}: ${adj.from} → ${adj.to} (${adj.rationale})`);
  }
  for (const hint of proposal.hints) {
    emit(`  hint: ${hint.message}`);
  }
  for (const skip of proposal.skipped) {
    emit(
      `  skip ${skip.complexity}: ${skip.reason}${
        skip.sampleCount !== undefined ? ` (samples=${skip.sampleCount})` : ""
      }`,
    );
  }
}

export async function routingCalibrateCommand(
  options: RoutingCalibrateOptions = {},
  deps: RoutingCalibrateDeps = _routingCalibrateDeps,
): Promise<RoutingCalibrateResult> {
  const workdir = options.workdir ?? process.cwd();
  const priorConfig = await deps.readConfig(workdir);

  const outputDir = options.outputDir ?? resolveOutputDir(workdir, undefined, priorConfig);

  const runs = await deps.loadRunMetrics(outputDir);

  if (runs.length === 0) {
    const emptyProposal: CalibrationProposal = {
      generatedAt: new Date().toISOString(),
      bandStats: [],
      adjustments: [],
      hints: [],
      skipped: [],
    };
    if (options.json) {
      deps.stdout(JSON.stringify(buildJsonView(emptyProposal)));
    } else {
      deps.stderr("[routing-calibrate] No run history found — insufficient history for calibration.");
    }
    return { proposal: emptyProposal, exitCode: 0 };
  }

  const priorMapping = (priorConfig ?? DEFAULT_CONFIG).autoMode.complexityRouting;
  const bandStats = computeBandStats(runs, priorMapping);

  const thresholds: { minSamples?: number } = {};
  if (options.minSamples !== undefined) thresholds.minSamples = options.minSamples;

  const proposal: CalibrationProposal = proposeAdjustments(bandStats, priorMapping, thresholds);
  proposal.generatedAt = new Date().toISOString();
  proposal.bandStats = bandStats;

  if (options.json) {
    deps.stdout(JSON.stringify(buildJsonView(proposal)));
  } else {
    printHumanView(deps.stdout, proposal);
  }

  if (options.apply && proposal.adjustments.length > 0) {
    const baseConfig = priorConfig ?? DEFAULT_CONFIG;
    const nextConfig: NaxConfig = {
      ...baseConfig,
      autoMode: {
        ...baseConfig.autoMode,
        complexityRouting: mergeComplexityRouting(
          baseConfig.autoMode.complexityRouting as unknown as Record<string, string>,
          proposal.adjustments,
        ),
      },
    };
    await deps.writeConfig(workdir, nextConfig);
    return { proposal, exitCode: 0, wroteConfig: true };
  }

  return { proposal, exitCode: 0 };
}
