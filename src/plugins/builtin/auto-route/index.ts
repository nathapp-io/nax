/**
 * Auto-Route Plugin — Built-in Post-Run Action
 *
 * Writes a per-run `routing-proposal.json` artifact describing tier-routing
 * adjustments inferred from run history. The artifact is **advisory**: the
 * plugin never writes project routing config — the CLI is the only writer
 * of `autoMode.complexityRouting`, and only when `--apply` is passed.
 *
 * Fail-open: a failed calibration never fails the run. `execute` catches,
 * logs via `ctx.logger`, and returns `{ success: true }`.
 */

import { join } from "node:path";
import type { ComplexityRung, ModelTier } from "@/config";
import { loadRunMetrics as _loadRunMetrics } from "@/metrics";
import type { IPostRunAction, NaxPlugin, PluginLogger, PostRunActionResult, PostRunContext } from "@/plugins/types";
import {
  computeBandStats as _computeBandStats,
  proposeAdjustments as _proposeAdjustments,
  buildProposalArtifact,
} from "@/routing";
import type { AutoRouteConfig, AutoRouteCoreFns, AutoRouteDeps } from "./types";

const PLUGIN_NAME = "nax-auto-route";
const PLUGIN_VERSION = "0.1.0";
const PROPOSAL_FILENAME = "routing-proposal.json";

/**
 * Module-level deps for testability (`_deps` pattern).
 *
 * Production callers read through these references; tests mutate fields on the
 * exported object to inject fakes without `mock.module()`.
 */
export const _autoRouteDeps: AutoRouteDeps & AutoRouteCoreFns = {
  loadRunMetrics: _loadRunMetrics,
  writeFile: async (filePath: string, contents: string) => {
    await Bun.write(filePath, contents);
  },
  proposeAdjustments: _proposeAdjustments,
  computeBandStats: _computeBandStats,
};

/** Read the loose `autoRoute` block from `ctx.config`. Defaults to enabled=false. */
function getAutoRouteConfig(context: PostRunContext): AutoRouteConfig {
  const cfg = context.config as Record<string, unknown> | undefined;
  if (!cfg)
    return {
      enabled: false,
      minSamples: 8,
      upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
      downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
    };
  const autoRoute = cfg.autoRoute as Partial<AutoRouteConfig> | undefined;
  if (!autoRoute)
    return {
      enabled: false,
      minSamples: 8,
      upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
      downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
    };
  return {
    enabled: autoRoute.enabled === true,
    minSamples: autoRoute.minSamples ?? 8,
    upgrade: {
      escalationRate: autoRoute.upgrade?.escalationRate ?? 0.3,
      mismatchRate: autoRoute.upgrade?.mismatchRate ?? 0.25,
    },
    downgrade: {
      firstPassRate: autoRoute.downgrade?.firstPassRate ?? 0.9,
      escalationRate: autoRoute.downgrade?.escalationRate ?? 0.05,
    },
  };
}

/** Read the loose `autoMode.complexityRouting` mapping from `ctx.config`. */
function getComplexityRouting(context: PostRunContext): Record<string, ModelTier> {
  const cfg = context.config as Record<string, unknown> | undefined;
  const autoMode = cfg?.autoMode as Record<string, unknown> | undefined;
  const mapping = autoMode?.complexityRouting as Record<string, ComplexityRung> | undefined;
  if (mapping) {
    return Object.fromEntries(
      Object.entries(mapping).map(([complexity, entry]) => [
        complexity,
        typeof entry === "string" ? entry : entry.tier,
      ]),
    );
  }
  return { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" };
}

/**
 * Per-run memo of the computed proposal, keyed by the `PostRunContext` identity
 * the runner passes to both `shouldRun` and `execute` for the same run — avoids
 * re-reading run history and recomputing calibration twice per run.
 */
const _proposalMemo = new WeakMap<PostRunContext, ReturnType<typeof _autoRouteDeps.proposeAdjustments>>();

/** Compute (once per context) the calibration proposal both `shouldRun` and `execute` need. */
async function computeProposal(context: PostRunContext, cfg: AutoRouteConfig) {
  const cached = _proposalMemo.get(context);
  if (cached) return cached;

  const mapping = getComplexityRouting(context);
  const outputDir = context.outputDir ?? context.globalDir;
  if (outputDir === undefined) {
    const empty = _autoRouteDeps.proposeAdjustments([], mapping, { minSamples: cfg.minSamples });
    _proposalMemo.set(context, empty);
    return empty;
  }
  const runs = await _autoRouteDeps.loadRunMetrics(outputDir);
  const bandStats = _autoRouteDeps.computeBandStats(runs, mapping);
  const proposal = _autoRouteDeps.proposeAdjustments(bandStats, mapping, {
    minSamples: cfg.minSamples,
    upgradeEscalationRate: cfg.upgrade.escalationRate,
    upgradeMismatchRate: cfg.upgrade.mismatchRate,
    downgradeEscalationRate: cfg.downgrade.escalationRate,
    downgradeFirstPassRate: cfg.downgrade.firstPassRate,
  });
  _proposalMemo.set(context, proposal);
  return proposal;
}

/** Build the proposal artifact from the same pipeline `shouldRun` evaluates. */
async function buildProposal(context: PostRunContext, cfg: AutoRouteConfig) {
  const proposal = await computeProposal(context, cfg);
  // The pure core is wall-clock free, so it emits an empty `generatedAt`.
  // The artifact is the public contract — stamp it here, at the I/O boundary.
  return { ...proposal, generatedAt: new Date().toISOString() };
}

/**
 * Auto-Route post-run action implementation.
 */
const autoRouteAction: IPostRunAction = {
  name: PLUGIN_NAME,
  description: "Writes a per-run routing proposal artifact (advisory only)",

  async shouldRun(context: PostRunContext): Promise<boolean> {
    const cfg = getAutoRouteConfig(context);
    if (!cfg.enabled) return false;

    // Reuse the pure core via the shared memo: it is fail-open and skips bands
    // below minSamples, returning empty adjustments when no band qualifies.
    const proposal = await computeProposal(context, cfg);

    return proposal.adjustments.length > 0;
  },

  async execute(context: PostRunContext): Promise<PostRunActionResult> {
    try {
      const cfg = getAutoRouteConfig(context);
      const outputDir = context.outputDir ?? context.globalDir;
      if (!outputDir) {
        return { success: true, message: "Auto-route proposal skipped — no outputDir available" };
      }

      const proposal = await buildProposal(context, cfg);
      const target = join(outputDir, PROPOSAL_FILENAME);

      await _autoRouteDeps.writeFile(target, JSON.stringify(buildProposalArtifact(proposal), null, 2));

      return {
        success: true,
        message: `Auto-route proposal written (${proposal.adjustments.length} adjustments)`,
      };
    } catch (err) {
      context.logger.warn("Auto-route execute failed", { error: String(err) });
      return { success: true, message: `Auto-route proposal write failed: ${String(err)}` };
    }
  },
};

/**
 * Built-in auto-route plugin.
 */
export const autoRoutePlugin: NaxPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  provides: ["post-run-action"],

  async setup(_config: Record<string, unknown>, _logger: PluginLogger): Promise<void> {
    // No initialization required
  },

  async teardown(): Promise<void> {
    // No cleanup required
  },

  extensions: {
    postRunAction: autoRouteAction,
  },
};
