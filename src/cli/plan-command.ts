/**
 * Plan Command — Generate prd.json from a spec file via planInteractiveOp
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * runs planning via callOp + planInteractiveOp, validates the JSON response,
 * and writes prd.json.
 *
 * Interactive mode: uses ACP session + stdin bridge for Q&A.
 */

import { basename } from "node:path";
import type { NaxConfig } from "../config";
import { NaxError } from "../errors";
import type { PlanResult } from "../plan/strategies";
import { buildPlanModeContext, createPlanStrategy } from "../plan/strategies";
import { errorMessage } from "../utils/errors";

export { assertIsValidPrd } from "../plan/strategies";

import { _planDeps } from "./plan-runtime";

// Re-exported for backward compatibility — callers that import from "./plan" still work.
export { _planDeps, createPlanRuntime, DEFAULT_TIMEOUT_SECONDS, resolvePlanModelSelection } from "./plan-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Mode resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolution order:
 * 1. config.plan.mode (explicit user override)
 * 2. single (default)
 */
export function resolvePlanMode(config: NaxConfig): "single" | "refine" {
  const explicit = config?.plan?.mode;
  if (explicit) return explicit;
  return "single";
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan options
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanCommandOptions {
  /** Path to spec file (--from) — required */
  from: string;
  /** Feature name (-f) — required */
  feature: string;
  /** @deprecated No longer used — kept for caller compatibility only */
  auto?: boolean;
  /** Override default branch name (-b) */
  branch?: string;
  /** `--no-spec-lint` — plan a spec that fails the extraction-integrity gate. */
  skipSpecLint?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence mode composition
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Project identity claim (US-004)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claim the project identity before any plan work is dispatched (US-004).
 *
 * projectKey derivation mirrors run-setup: `config.name?.trim() || basename(workdir)`.
 * The origin URL is read the same way — via `_planDeps.spawnSync(["git", "remote",
 * "get-url", "origin"])` — and is null when the lookup fails. A RUN_NAME_COLLISION
 * collision is propagated (plan must not dispatch paid work into another project's
 * cost records); any other claim failure is bookkeeping and warns without blocking.
 */
async function claimPlanIdentity(workdir: string, config: NaxConfig): Promise<void> {
  let remoteUrl: string | null = null;
  try {
    const gitResult = _planDeps.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
    if (gitResult.exitCode === 0) {
      remoteUrl = gitResult.stdout.toString().trim() || null;
    }
  } catch {
    // non-git project — remoteUrl stays null
  }
  const projectKey = config.name?.trim() || basename(workdir);
  try {
    await _planDeps.claimProjectIdentity(projectKey, workdir, remoteUrl);
  } catch (err) {
    if (err instanceof NaxError && err.code === "RUN_NAME_COLLISION") {
      throw err;
    }
    _planDeps.getLogger()?.warn("plan", "Failed to claim project identity", {
      projectKey,
      error: errorMessage(err),
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the plan command: read spec, call LLM via planInteractiveOp, write prd.json.
 *
 * @param workdir - Project root directory
 * @param config  - Nax configuration
 * @param options - Command options
 * @returns The generated prd.json path, plus `degraded` when the plan threw and
 *          the PRD had to be recovered from disk.
 */
export async function planCommand(
  workdir: string,
  config: NaxConfig,
  options: PlanCommandOptions,
): Promise<PlanResult> {
  await claimPlanIdentity(workdir, config);
  const ctx = await buildPlanModeContext(workdir, config, options, _planDeps);
  try {
    const mode = resolvePlanMode(config);
    const strategy = createPlanStrategy(mode);
    return await strategy.execute(ctx);
  } finally {
    if (ctx.interactionChain) await ctx.interactionChain.destroy().catch(() => {});
  }
}



// Re-exports for backward compatibility — planDecomposeCommand and runReplanLoop
// were extracted to plan-decompose.ts to keep plan.ts under the 600-line limit.
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
