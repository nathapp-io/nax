/** Repo-scoped fix nodes: one session, then an independent committed-tree safety check. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel, NaxConfig } from "@/config";
import type { CurrentUser, ForgeDeps, OwnComment, PrInfo, PrRef, PrThread } from "@/forge";
import { getLogger } from "@/logger";
import type { GraphState, StepResult } from "@/step-graph";
import { gitWithTimeout } from "@/utils/git";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { type GateCommand, runQualityGates } from "../finish/gates/quality";
import { runBranchFix } from "../workflow/branch-fix";
import type { CiWaitOutcome } from "../workflow/ci-wait";
import { readHead } from "../workflow/git";
import { changedPaths, type PrCheckout } from "./checkout";
import type { BotChecks } from "./checks";
import { toFixFindings } from "./fix-input";
import { failingOnHead, logGateFailure, readHeadCi } from "./gate-baseline";
import { botModel } from "./models";
import { fixProtectedPaths } from "./path-policy";
import type { BotReviewArtifact } from "./post";

export type BotFixStep = "fix" | "check" | "gates" | "push" | "reply" | "ready" | "report" | "done";

export interface BotFixState extends GraphState<BotFixStep> {
  readonly outcome?:
    | "pushed"
    | "nothing"
    | "no-change"
    | "protected"
    | "no-gates"
    | "gates-failed"
    | "baseline-red"
    | "push-rejected"
    | "push-unknown"
    | "dirty"
    | "setup-failed";
  readonly setupFailed?: string;
  readonly changed?: readonly string[];
  readonly protectedFiles?: readonly string[];
  readonly failingGates?: readonly string[];
  /** Of `failingGates`, those that fail on the unmodified PR head too; absent when the head could not be checked out. */
  readonly baselineFailing?: readonly string[];
  /** CI's verdict on the exact PR head, read once when a gate failed. */
  readonly ciOutcome?: CiWaitOutcome;
  readonly pushedSha?: string;
  readonly replied?: number;
  readonly resolved?: number;
  readonly markedReady?: boolean;
  /** Why the PR stayed a draft (US-005): a workflow PR, or a CI that is not green. */
  readonly readyHeld?: string;
  readonly fixFailure?: string;
  readonly agreedCount?: number;
  readonly fixDirty?: boolean;
  readonly recoveryPath?: string;
}

export interface BotFixEnv {
  readonly ctx: PrStepContext;
  readonly config: NaxConfig;
  readonly checks: BotChecks;
  readonly ref: PrRef;
  readonly info: PrInfo;
  readonly checkout: PrCheckout;
  readonly review: BotReviewArtifact;
  readonly model?: ConfiguredModel;
  readonly forge: ForgeDeps;
  readonly repoRoot: string;
  readonly user: CurrentUser;
  readonly threads: readonly PrThread[];
  readonly own: readonly OwnComment[];
}

const PUSH_TIMEOUT_MS = 120_000;

export const _fixStepsDeps = {
  runBranchFix,
  changedPaths,
  runQualityGates,
  failingOnHead,
  readHeadCi,
  runGit: gitWithTimeout,
  readHead,
};

export async function fixStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const agreedCount = env.review.agreed.length;
  if (agreedCount === 0) return { patch: { agreedCount, outcome: "nothing" }, exit: "nothing" };
  const result = await _fixStepsDeps.runBranchFix(env.ctx, {
    findings: toFixFindings(env.review.agreed),
    model: botModel(env.config, "fix", env.model),
  });
  return {
    patch: {
      agreedCount,
      ...(result.dirty ? { fixDirty: true } : {}),
      ...(result.failure !== undefined ? { fixFailure: result.failure } : {}),
    },
    exit: "ran",
  };
}

/** Never verify or push a different tree from HEAD. Retain the registered checkout for recovery. */
async function unsafeTree(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState> | undefined> {
  let clean = false;
  try {
    const status = await _fixStepsDeps.runGit(
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      env.checkout.worktree,
    );
    clean = status.exitCode === 0 && status.stdout === "" && !state.fixDirty;
  } catch {
    // An unreadable tree is not a clean tree.
  }
  if (clean) return undefined;
  env.checkout.retain?.();
  return { patch: { outcome: "dirty", recoveryPath: env.checkout.worktree }, exit: "dirty" };
}

export async function checkStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const unsafe = await unsafeTree(env, _state);
  if (unsafe) return unsafe;
  // changedPaths uses --no-renames: a move out of a protected directory is still a protected edit.
  const changed = await _fixStepsDeps.changedPaths(env.checkout.worktree, env.info.headSha);
  if (changed.length === 0) return { patch: { changed, outcome: "no-change" }, exit: "no-change" };
  const protectedFiles = fixProtectedPaths(changed);
  if (protectedFiles.length > 0) {
    return { patch: { changed, protectedFiles, outcome: "protected" }, exit: "protected" };
  }
  return { patch: { changed }, exit: "changed" };
}

export async function gatesStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const unsafe = await unsafeTree(env, _state);
  if (unsafe) return unsafe;
  const commands = env.checks.gates;
  if (commands.length === 0) return { patch: { outcome: "no-gates" }, exit: "no-gates" };
  // Use the reviewed checks, but verify the fixed tree, never the snapshot.
  const worktreeCommands = commands.map((gate) => ({ ...gate, cwd: env.checkout.worktree }));
  const result = await _fixStepsDeps.runQualityGates(env.checkout.worktree, worktreeCommands, {
    onGate: logGateFailure("fix"),
  });
  if (!result.passed) return { patch: await classifyRedGates(env, worktreeCommands, result.failing), exit: "failed" };
  return { patch: {}, exit: "passed" };
}

/** A red gate is the fix's only when the unmodified head passes it (nax#2631). */
async function classifyRedGates(
  env: BotFixEnv,
  gates: GateCommand[],
  failing: readonly string[],
): Promise<Partial<BotFixState>> {
  const { info, checkout, ref, repoRoot } = env;
  const red = gates.filter((gate) => failing.includes(gate.name));
  const [ci, baselineFailing] = await Promise.all([
    _fixStepsDeps.readHeadCi({ forge: ref.forge, url: info.url, repoRoot, headSha: info.headSha }),
    _fixStepsDeps.failingOnHead(checkout.worktree, info.headSha, red).catch((err) => {
      getLogger()?.warn("bot-fix", "Baseline gate run failed; the red gates stay attributed to the fix", {
        error: errorMessage(err),
      });
      return undefined;
    }),
  ]);
  const preExisting = baselineFailing !== undefined && failing.every((name) => baselineFailing.includes(name));
  return {
    failingGates: failing,
    ...(baselineFailing === undefined ? {} : { baselineFailing }),
    ciOutcome: ci.outcome,
    outcome: preExisting ? "baseline-red" : "gates-failed",
  };
}

export async function pushStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const unsafe = await unsafeTree(env, _state);
  if (unsafe) return unsafe;
  const result = await _fixStepsDeps.runGit(
    ["push", "origin", `HEAD:refs/heads/${env.info.headRef}`],
    env.checkout.worktree,
    PUSH_TIMEOUT_MS,
  );
  if (result.timedOut) return { patch: { outcome: "push-unknown" }, exit: "rejected" };
  if (result.exitCode !== 0) return { patch: { outcome: "push-rejected" }, exit: "rejected" };
  const pushedSha = await _fixStepsDeps.readHead(env.checkout.worktree);
  return { patch: { pushedSha, outcome: "pushed" }, exit: "pushed" };
}
