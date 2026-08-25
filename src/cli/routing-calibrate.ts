import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { NaxConfig } from "../config";
import { loadConfig as _loadConfig, DEFAULT_CONFIG, deepMergeConfig } from "../config";
import { NaxError } from "../errors";
import type { RunMetrics } from "../metrics";
import { loadRunMetrics as _loadRunMetrics } from "../metrics";
import { buildProposalArtifact, computeBandStats, proposeAdjustments } from "../routing";
import type { CalibrationProposal, TierAdjustment } from "../routing/calibrate";
import { projectInputDir, projectOutputDir } from "../runtime";
import { saveJsonFile } from "../utils/json-file";

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
  // `loadConfig` never returns null for "no config file" — that case resolves to
  // DEFAULT_CONFIG. A thrown error here means the existing config is genuinely
  // invalid (legacy keys, failed schema parse), so it must propagate rather than
  // be swallowed into `null` — treating it as "no prior config" would let `--apply`
  // silently overwrite the user's real (if stale) config with defaults.
  readConfig: (workdir: string): Promise<NaxConfig | null> => _loadConfig(workdir),
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

/**
 * Parse the `--min-samples` CLI flag value (delivered as a string by
 * Commander) into a non-negative integer. Returns `undefined` when the
 * flag was not provided; throws on any malformed or out-of-range input
 * so the caller can surface the user-facing error.
 *
 * Strict to avoid silent misconfiguration:
 *  - "20abc", "3.5", "-1", " 20 ", "" → reject.
 *  - "20" → 20; "0" → 0 (a valid floor of zero disables the threshold).
 */
export function parseMinSamplesFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new NaxError(`--min-samples must be a non-negative integer (got "${raw}")`, "INVALID_MIN_SAMPLES", {
      stage: "routing-calibrate",
      value: raw,
    });
  }
  const parsed = Number.parseInt(raw, 10);
  return parsed;
}

/**
 * Action handler for the `nax routing calibrate` Commander subcommand.
 * Accepts the post-Commander `options` object (i.e., the `options` argument
 * Commander passes to `.action((options) => ...)`) and forwards into
 * `routingCalibrateCommand` after validating `--min-samples`.
 *
 * Returns the same `{ exitCode, proposal, wroteConfig }` shape but does NOT
 * call `process.exit`; the bin wrapper is responsible for that. Splitting this
 * out lets tests wire the same handler into a fresh Commander program and
 * assert end-to-end parse + forwarding without spawning `bin/nax.ts`.
 */
export async function runRoutingCalibrateCli(
  options: { dir?: string; apply?: boolean; json?: boolean; minSamples?: string },
  deps: RoutingCalibrateDeps = _routingCalibrateDeps,
): Promise<RoutingCalibrateResult> {
  let minSamples: number | undefined;
  try {
    minSamples = parseMinSamplesFlag(options.minSamples);
  } catch (err) {
    deps.stderr((err as Error).message);
    return {
      proposal: {
        generatedAt: new Date().toISOString(),
        bandStats: [],
        adjustments: [],
        hints: [],
        skipped: [],
      },
      exitCode: 1,
    };
  }
  return routingCalibrateCommand(
    {
      workdir: options.dir,
      apply: Boolean(options.apply),
      json: Boolean(options.json),
      minSamples,
    },
    deps,
  );
}

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
  const priorPartial = await deps.readConfig(workdir);
  // Materialize against DEFAULT_CONFIG so partial overlays (e.g. `{ execution: ... }`)
  // do not leave `autoMode` undefined when we read the complexity mapping or apply.
  const priorConfig: NaxConfig = priorPartial
    ? (deepMergeConfig(
        structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
        priorPartial as unknown as Record<string, unknown>,
      ) as unknown as NaxConfig)
    : DEFAULT_CONFIG;

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
      deps.stdout(JSON.stringify(buildProposalArtifact(emptyProposal)));
    } else {
      deps.stderr("[routing-calibrate] No run history found — insufficient history for calibration.");
    }
    return { proposal: emptyProposal, exitCode: 0 };
  }

  const priorMapping = priorConfig.autoMode.complexityRouting;
  const bandStats = computeBandStats(runs, priorMapping);

  const thresholds: { minSamples?: number } = {};
  if (options.minSamples !== undefined) thresholds.minSamples = options.minSamples;

  const proposal: CalibrationProposal = proposeAdjustments(bandStats, priorMapping, thresholds);
  proposal.generatedAt = new Date().toISOString();
  proposal.bandStats = bandStats;

  if (options.json) {
    deps.stdout(JSON.stringify(buildProposalArtifact(proposal)));
  } else {
    printHumanView(deps.stdout, proposal);
  }

  if (options.apply && proposal.adjustments.length > 0) {
    const nextConfig: NaxConfig = {
      ...priorConfig,
      autoMode: {
        ...priorConfig.autoMode,
        complexityRouting: mergeComplexityRouting(
          priorConfig.autoMode.complexityRouting as unknown as Record<string, string>,
          proposal.adjustments,
        ),
      },
    };
    await deps.writeConfig(workdir, nextConfig);
    return { proposal, exitCode: 0, wroteConfig: true };
  }

  return { proposal, exitCode: 0 };
}
