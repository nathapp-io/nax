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

import type { MutationCheckDeps } from "@/operations";
import type { NaxRuntime } from "@/runtime";

/**
 * `MutationCheckDeps` with every collaborator stubbed to a benign success: no
 * changed files, no line ranges, a full-suite selection, and a passing
 * regression run. Override only what the test is about.
 */
export function makeMutationCheckDeps(overrides: Partial<MutationCheckDeps> = {}): MutationCheckDeps {
  return {
    detectLanguage: async () => "typescript" as any,
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

/**
 * A `CallContext` for `mutationCheckOp`, with `execution` as the first argument
 * because that is the slice almost every test varies.
 *
 * The runtime always carries both `mutationSummaries` and `dirtyWorktrees`.
 * The op reaches each through optional chaining, so supplying them is
 * harmless for tests that ignore them and removes a footgun for tests that
 * exercise the revert path and would otherwise fail on an absent `Set`.
 */
export function makeMutationCheckCtx(
  execution: Record<string, unknown> = {},
  options: MutationCheckCtxOptions = {},
): any {
  const {
    runtime = {},
    quality = { commands: { test: "bun test" } },
    storyId = "US-004",
    packageDir = "packages/agent",
    repoRoot = "/repo",
  } = options;
  const config = { execution, quality } as any;
  return {
    runtime: { mutationSummaries: new Map(), dirtyWorktrees: new Set<string>(), ...runtime },
    storyId,
    packageView: {
      packageDir,
      repoRoot,
      hasOverride: false,
      config,
      select: (s: any) => s.select(config),
    },
  } as any;
}
