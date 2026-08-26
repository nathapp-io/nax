/**
 * Shared fixtures for `mutationCheckOp` unit tests.
 *
 * The deps object and the `CallContext` shape were duplicated verbatim across
 * five files under `test/unit/operations/` (`mutation-check`, `-selection`,
 * `-revert`, `-diff-scope`, `-telemetry`), which is well past the "same mock in
 * 3+ test files" threshold in `.claude/rules/test-helpers.md`.
 *
 * Deliberately NOT shared with `full-suite-gate` / `verify-scoped`: those name
 * their locals the same way but build a different context (config passed whole
 * rather than under `execution`, no mutation runtime) against a different deps
 * type. Merging them would be an abstraction over a coincidence of naming.
 */

import type { ConfigSelector, NaxConfig } from "@/config";
import type { MutationCheckDeps } from "@/operations";
import type { CallContext } from "@/operations/types";
import type { NaxRuntime, PackageView } from "@/runtime";
import { makeNaxConfig } from "./mock-nax-config";
import { makeMockRuntime } from "./runtime";

/**
 * `MutationCheckDeps` with every collaborator stubbed to a benign success: no
 * changed files, no line ranges, a full-suite selection, and a passing
 * regression run. Override only what the test is about.
 */
export function makeMutationCheckDeps(overrides: Partial<MutationCheckDeps> = {}): MutationCheckDeps {
  return {
    detectLanguage: async () => "typescript",
    getChangedNonTestFiles: async () => [],
    getChangedLineRanges: async () => new Map(),
    getGitRoot: async () => null,
    selectScopedTests: async () => ({
      effectiveCommand: "bun test",
      isFullSuite: true,
      thresholdFallback: false,
      isMonorepoOrchestrator: false,
    }),
    regression: async () => ({
      status: "SUCCESS" as const,
      success: true,
      countsTowardEscalation: true,
      output: "",
    }),
    ...overrides,
  };
}

export interface MutationCheckCtxOptions {
  /** Extra `NaxRuntime` fields, merged over the mutation-aware defaults. */
  readonly runtime?: Partial<NaxRuntime>;
  /** Replaces the default `{ commands: { test: "bun test" } }` wholesale. */
  readonly quality?: Record<string, unknown>;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly repoRoot?: string;
}

function makePackageView(config: NaxConfig, packageDir: string, repoRoot: string): PackageView {
  return {
    packageDir,
    relativeFromRoot: "",
    repoRoot,
    hasOverride: false,
    config,
    select<C>(selector: ConfigSelector<C>): C {
      return selector.select(config);
    },
  };
}

/**
 * Mirror the historical config contract onto a real `NaxConfig`: the default is
 * `quality.commands = { test: "bun test" }`, and a supplied `quality` replaces
 * the subtree wholesale (so `{}` means "no commands configured").
 *
 * `makeNaxConfig()` shares each unmodified subtree with `DEFAULT_CONFIG`
 * (deepMerge clones only the levels it descends into), so the config is
 * deep-cloned before either write below — otherwise they would mutate the
 * process-wide default and leak into every later test in the same worker.
 */
function applyQuality(config: NaxConfig, quality: Record<string, unknown> | undefined): void {
  if (quality === undefined) {
    config.quality.commands = { test: "bun test" };
    return;
  }
  config.quality.commands = {};
  const commands = quality.commands;
  if (typeof commands === "object" && commands !== null) {
    Object.assign(config.quality.commands, commands);
  }
}

/**
 * A real `CallContext` for `mutationCheckOp`, with `execution` as the first
 * argument because that is the slice almost every test varies. The execution
 * bag is merged over the default config; `quality` (see options) replaces
 * wholesale.
 *
 * `storyId` stays writable: tests re-point it (or strip it) after construction
 * to exercise summary attribution, which `CallContext` declares readonly.
 */
type MutationCheckCtx = Omit<CallContext, "storyId"> & { storyId?: string | undefined };

export function makeMutationCheckCtx(
  execution: Record<string, unknown> = {},
  options: MutationCheckCtxOptions = {},
): MutationCheckCtx {
  const { runtime = {}, quality, storyId = "US-004", packageDir = "packages/agent", repoRoot = "/repo" } = options;
  const config = structuredClone(makeNaxConfig());
  applyQuality(config, quality);
  Object.assign(config.execution, execution);
  return {
    runtime: Object.assign(makeMockRuntime(), runtime),
    storyId,
    packageDir,
    packageView: makePackageView(config, packageDir, repoRoot),
    agentName: "claude",
  };
}
