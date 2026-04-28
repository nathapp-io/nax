/**
 * Plan runtime helpers — extracted from plan.ts.
 *
 * Contains DEFAULT_TIMEOUT_SECONDS, createPlanRuntime, resolvePlanModelSelection,
 * and _planDeps. Extracted to break the circular static import between plan.ts
 * and plan-decompose.ts: both files now import from this module instead of each other.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IAgentManager } from "../agents";
import { scanCodebase } from "../analyze/scanner";
import type { CodebaseScan } from "../analyze/types";
import type { NaxConfig } from "../config";
import { DEFAULT_CONFIG, resolveConfiguredModel } from "../config";
import { discoverWorkspacePackages } from "../context/generator";
import { DebateRunner } from "../debate";
import type { DebateRunnerOptions } from "../debate";
import { initInteractionChain } from "../interaction/init";
import { getLogger } from "../logger";
import type { PRD } from "../prd/types";
import type { PrecheckResultWithCode } from "../precheck";
import type { NaxRuntime } from "../runtime";
import { createRuntime } from "../runtime";
import { errorMessage } from "../utils/errors";
import { createCliInteractionBridge } from "./plan-helpers";

export const DEFAULT_TIMEOUT_SECONDS = 600;

function isRuntimeWithAgentManager(value: unknown): value is NaxRuntime {
  return typeof value === "object" && value !== null && "agentManager" in value;
}

export function createPlanRuntime(config: NaxConfig, workdir: string, featureName: string): NaxRuntime {
  const candidate = _planDeps.createRuntime(config, workdir, featureName) as unknown;
  if (isRuntimeWithAgentManager(candidate)) return candidate;
  return createRuntime(config, workdir, {
    agentManager: candidate as IAgentManager,
    featureName,
  });
}

export function resolvePlanModelSelection(config: NaxConfig, preferredAgent: string) {
  const selection = config.plan?.model ?? "balanced";
  const defaultAgent = config.agent?.default ?? preferredAgent;
  try {
    return resolveConfiguredModel(config.models ?? DEFAULT_CONFIG.models, preferredAgent, selection, defaultAgent);
  } catch (err) {
    getLogger()?.warn("plan", "Failed to resolve plan model from config, falling back to defaults", {
      error: errorMessage(err),
    });
    return resolveConfiguredModel(DEFAULT_CONFIG.models, preferredAgent, "balanced", defaultAgent);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dependency injection (_planDeps) — override in tests
// ─────────────────────────────────────────────────────────────────────────────

export const _planDeps = {
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: (path: string, content: string): Promise<void> => Bun.write(path, content).then(() => {}),
  scanCodebase: (workdir: string): Promise<CodebaseScan> => scanCodebase(workdir),
  createRuntime: (cfg: NaxConfig, wd: string, featureName: string) => createRuntime(cfg, wd, { featureName }),
  readPackageJson: (workdir: string): Promise<Record<string, unknown> | null> =>
    Bun.file(join(workdir, "package.json"))
      .json()
      .catch(() => null),
  spawnSync: (cmd: string[], opts?: { cwd?: string }): { stdout: Buffer; exitCode: number | null } => {
    const result = Bun.spawnSync(cmd, opts ? { cwd: opts.cwd } : {});
    return { stdout: result.stdout as Buffer, exitCode: result.exitCode };
  },
  mkdirp: (path: string): Promise<void> => Bun.spawn(["mkdir", "-p", path]).exited.then(() => {}),
  existsSync: (path: string): boolean => existsSync(path),
  discoverWorkspacePackages: (repoRoot: string): Promise<string[]> => discoverWorkspacePackages(repoRoot),
  readPackageJsonAt: (path: string): Promise<Record<string, unknown> | null> =>
    Bun.file(path)
      .json()
      .catch(() => null),
  createInteractionBridge: (): {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  } => createCliInteractionBridge(),
  initInteractionChain: (cfg: NaxConfig, headless: boolean) => initInteractionChain(cfg, headless),
  createDebateRunner: (opts: DebateRunnerOptions): DebateRunner => new DebateRunner(opts),
  runPrecheck: async (
    config: NaxConfig,
    prd: PRD,
    opts: { workdir: string; silent?: boolean },
  ): Promise<PrecheckResultWithCode> => {
    const { runPrecheck } = await import("../precheck");
    return runPrecheck(config, prd, opts);
  },
  processExit: (code: number): never => process.exit(code),
  planDecompose: (
    workdir: string,
    config: NaxConfig,
    opts: { feature: string; storyId: string },
  ): Promise<() => void> =>
    import("./plan-decompose").then(({ planDecomposeCommand }) => planDecomposeCommand(workdir, config, opts)),
};
