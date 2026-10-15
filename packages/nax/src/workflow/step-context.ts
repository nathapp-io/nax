/**
 * What every workflow step needs, built once per story by the stage (Task 11).
 * `_workflowDeps` is the single test seam: every agent call goes through
 * `_workflowDeps.callOp`, so a test fakes the agent in one place.
 */
import { createAdvisor, readTrustedDecisions } from "@/advisor";
import { resolveFeatureSpec } from "@/cli";
import type { NaxConfig, TierConfig, WorkflowConfig } from "@/config";
import { callOp } from "@/operations";
import type { CallContext, Operation } from "@/operations/types";
import type { UserStory } from "@/prd";
import type { ISessionManager } from "@/session/types";
import { type ResolvedTestPatterns, resolveTestFilePatterns } from "@/test-runners";
import { autoCommitIfDirty, gitWithTimeout } from "@/utils/git";
import type { NaxIgnoreIndex } from "@/utils/path-filters";

export interface StepContext {
  readonly callCtx: CallContext;
  readonly story: UserStory;
  /** Per-story effective config. */
  readonly config: NaxConfig;
  /** resolveWorkflowConfig(rootConfig). */
  readonly workflow: WorkflowConfig;
  readonly tierOrder: readonly TierConfig[];
  readonly feature: string;
  /** Repo root (git cwd). */
  readonly projectDir: string;
  /** Story package dir. */
  readonly workdir: string;
  readonly runDir: string;
  /** The run output dir (advisor ledger and audit location). */
  readonly outputDir: string;
  readonly storyDir: string;
  readonly briefPath: string;
  readonly reportPath: string;
  /** BASE (ctx.storyGitRef). */
  readonly base: string;
  readonly runSignal?: AbortSignal;
  readonly sessionManager?: ISessionManager;
  readonly dryRun: boolean;
  readonly sessionScratchDir?: string;
  readonly naxIgnoreIndex?: NaxIgnoreIndex;
  readonly resolvedTestPatterns?: ResolvedTestPatterns;
  readonly contextMarkdown?: string;
  readonly featureContextMarkdown?: string;
  readonly constitution?: string;
}

export const _workflowDeps = {
  callOp: callOp as <I, O, C>(ctx: CallContext, op: Operation<I, O, C>, input: I) => Promise<O>,
  git: async (args: string[], cwd: string): Promise<{ stdout: string; stderr?: string; exitCode: number }> => {
    const { stdout, stderr, exitCode } = await gitWithTimeout(args, cwd);
    return { stdout, stderr, exitCode };
  },
  autoCommitIfDirty,
  resolveFeatureSpec: (feature: string, workdir: string): Promise<{ specSource?: { path: string } | null }> =>
    resolveFeatureSpec(feature, workdir),
  createAdvisor: createAdvisor as typeof createAdvisor,
  readTrustedDecisions: readTrustedDecisions as typeof readTrustedDecisions,
  resolveTestPatterns: resolveTestFilePatterns,
  now: (): number => Date.now(),
};
