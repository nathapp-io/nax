/** Repo-scoped fix nodes: one session, then an independent committed-tree safety check. */
import { lstat } from "node:fs/promises";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type ConfiguredModel, DEFAULT_CONFIG, type NaxConfig } from "@/config";
import type { CurrentUser, ForgeDeps, OwnComment, PrInfo, PrRef, PrThread } from "@/forge";
import { createForgeReadProvider } from "@/forge-tools";
import { getLogger } from "@/logger";
import type { WorkflowSeverity } from "@/operations/workflow-types";
import { buildBotPrFixPrompt, renderCheckoutState } from "@/prompts";
import type { GraphState, StepResult } from "@/step-graph";
import type { FindingTrigger } from "@/workflow/blocking-findings";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { type GateCommand, gateOutputTail, runQualityGates } from "../finish/gates/quality";
import { runBranchFix } from "../workflow/branch-fix";
import type { CiWaitOutcome } from "../workflow/ci-wait";
import { readHead } from "../workflow/git";
import { changedPaths, type PrCheckout } from "./checkout";
import { listCiConfigFiles } from "./checkout-state";
import { type BotChecks, barCommands } from "./checks";
import { findingFactLines, type LineagePushFact, lineagePushFacts, outsideDeclaredGrowth } from "./fix-facts";
import { toFixFindings } from "./fix-input";
import { failingOnHead, logGateFailure, readHeadCi } from "./gate-baseline";
import { botGit } from "./git";
import { featureIntentPaths } from "./intent";
import { botModel } from "./models";
import { fixProtectedPaths } from "./path-policy";
import type { AgreedItem, BotReviewArtifact } from "./post";
import { ownLedgerEntries } from "./push-record";
import { hasPushWorthyItem, reviewBlockingTriggers } from "./review-blocking";

export type BotFixStep =
  | "fix"
  | "repair"
  | "check"
  | "gates"
  | "ledger"
  | "push"
  | "reply"
  | "ready"
  | "report"
  | "done";

/** A finding the fix session left alone because it cannot hold readiness (US-007). */
export interface BotFixFollowUp {
  readonly key: string;
  readonly severity: WorkflowSeverity;
  readonly trigger: FindingTrigger;
}

export interface BotFixState extends GraphState<BotFixStep> {
  readonly readyOnly?: boolean;
  readonly outcome?:
    | "ready-pass"
    | "pushed"
    | "nothing"
    | "no-change"
    | "protected"
    | "no-gates"
    | "gates-failed"
    | "baseline-red"
    | "prepare-touched-tracked"
    | "push-rejected"
    | "push-unknown"
    | "dirty"
    | "setup-failed"
    | "cost-limit";
  readonly costSpentUsd?: number;
  readonly costLimitUsd?: number;
  readonly gateTails?: readonly { name: string; tail: string }[];
  readonly prepareTreeUnreadable?: boolean;
  readonly gateRepairRounds?: number;
  readonly repairMode?: "repair" | "prepare";
  readonly repairSkippedForCost?: boolean;
  readonly setupFailed?: string;
  readonly changed?: readonly string[];
  readonly protectedFiles?: readonly string[];
  readonly failingGates?: readonly string[];
  /** Of `failingGates`, those that fail on the unmodified PR head too; absent when the head could not be checked out. */
  readonly baselineFailing?: readonly string[];
  /** CI's verdict on the exact PR head, read once when a gate failed. */
  readonly ciOutcome?: CiWaitOutcome;
  readonly ledgerCarried?: boolean;
  readonly pushedSha?: string;
  readonly replied?: number;
  readonly resolved?: number;
  readonly markedReady?: boolean;
  /** Why the PR stayed a draft (US-005): a workflow PR, or a CI that is not green. */
  readonly readyHeld?: string;
  /** The CI waiver the ready pass recorded before readying the PR (US-007). */
  readonly ciWaived?: { readonly checks: readonly string[]; readonly reason: string };
  readonly reusedFix?: string;
  /** The reviews the saved patch actually worked from; older saves may not have this evidence. */
  readonly reusedFindingProvenance?: readonly { readonly key: string; readonly raisedBy: string }[];
  readonly fixSha?: string;
  readonly fixFailure?: string;
  readonly agreedCount?: number;
  /** US-007: the agreed findings this execution left alone, in `agreed` order; only on a `nothing` outcome. */
  readonly followUps?: readonly BotFixFollowUp[];
  readonly fixDirty?: boolean;
  /** Absolute; local only. The PR comment renders it relative to the repo root (nax#2681). */
  readonly recoveryPath?: string;
  /** The fix checkout no longer exists (another process removed it mid-session, nax#2681). */
  readonly checkoutMissing?: boolean;
}

export interface BotFixEnv {
  readonly cost: { readonly limitUsd: number; spentUsd(): number };
  readonly ctx: PrStepContext;
  readonly config: NaxConfig;
  readonly checks: BotChecks;
  readonly ref: PrRef;
  readonly info: PrInfo;
  readonly checkout: PrCheckout;
  readonly review: BotReviewArtifact;
  /**
   * The head's latest code review when `review` is a conversation-only artifact (US-001): that review
   * read no code, so the head's open findings live in the earlier code review.
   */
  readonly codeReview?: BotReviewArtifact;
  readonly model?: ConfiguredModel;
  readonly forge: ForgeDeps;
  readonly repoRoot: string;
  readonly user: CurrentUser;
  readonly threads: readonly PrThread[];
  readonly own: readonly OwnComment[];
  /** The validated `--waive-starved` reason; absent means this pass may not waive a starved CI (US-007). */
  readonly waiveStarved?: string;
}

const PUSH_TIMEOUT_MS = 120_000;

export const _fixStepsDeps = {
  runBranchFix,
  changedPaths,
  runQualityGates,
  failingOnHead,
  readHeadCi,
  runGit: botGit,
  readHead,
  worktreeExists: async (path: string): Promise<boolean> => {
    try {
      await lstat(path);
      return true;
    } catch {
      // Absent or unreadable: either way there is no checkout to recover from.
      return false;
    }
  },
};

/**
 * US-007: each agreed finding's key, severity and trigger class for the summary's follow-up line. Only
 * findings reach here — a thread or comment item always makes the review push-worthy — but the guard
 * keeps the mapping total over `AgreedItem`.
 */
function followUpsOf(agreed: readonly AgreedItem[]): readonly BotFixFollowUp[] {
  return agreed.flatMap((item) =>
    item.kind === "finding"
      ? [{ key: item.key, severity: item.severity, trigger: item.trigger ?? "normal" } satisfies BotFixFollowUp]
      : [],
  );
}

export async function fixStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const agreedCount = env.review.agreed.length;
  if (agreedCount === 0) return { patch: { agreedCount, outcome: "nothing" }, exit: "nothing" };
  // US-007: a session and its push are only worth it for an item that can hold readiness. Anything else
  // is a follow-up the summary names — acting on it reversed a human's decision and reset readiness (#2979).
  if (!hasPushWorthyItem(env)) {
    return { patch: { agreedCount, outcome: "nothing", followUps: followUpsOf(env.review.agreed) }, exit: "nothing" };
  }
  const findings = toFixFindings(env.review.agreed);
  const intent = featureIntentPaths(env.checkout);
  const prompt = buildBotPrFixPrompt({
    mode: "fix",
    pr: env.info,
    ...intent,
    findings,
    ...(await fixPromptFacts(env, intent.prdPath)),
    bar: barCommands(env.checks),
    checkoutState: renderCheckoutState({
      phase: "fresh",
      pinnedBase: env.checkout.inPlace !== true,
      headSha: env.info.headSha,
      setup: env.checks.preRun.map((step) => step.command),
      ciFiles: await listCiConfigFiles(env.checkout.worktree),
    }),
    reportPath: env.ctx.reportPath,
  });
  const result = await _fixStepsDeps.runBranchFix(env.ctx, {
    findings,
    model: botModel(env.config, "fix", env.model),
    prompt,
    toolProviders: [createForgeReadProvider({ resolveRef: async () => env.ref, deps: env.forge, cwd: env.repoRoot })],
  });
  const fixSha = await readFixHead(env);
  return {
    patch: {
      agreedCount,
      ...(fixSha !== undefined ? { fixSha } : {}),
      ...(result.dirty ? { fixDirty: true } : {}),
      ...(result.failure !== undefined ? { fixFailure: result.failure } : {}),
    },
    exit: "ran",
  };
}

/**
 * US-006: what the fix prompt may state about the round it is in — each item's trigger, lineage and
 * readiness, and the lines earlier bot pushes added outside the feature's declared files. The facts
 * come from the review artifact that decided this fix and from the bot's own ledger; nothing here
 * decides anything, and a fact that cannot be read is simply absent.
 *
 * #2998: a push several findings sit on is named once, beside the per-finding lines, instead of once
 * per parent on every finding's `Lineage:` line.
 */
async function fixPromptFacts(
  env: BotFixEnv,
  prdPath: string | undefined,
): Promise<{
  readonly findingFacts: readonly { readonly id: string; readonly lines: readonly string[] }[];
  readonly lineagePushes?: readonly LineagePushFact[];
  readonly outsideGrowth?: readonly { readonly path: string; readonly added: number }[];
}> {
  // US-004/B1: the bot's recorded pushes — the summary's block plus the append-only copy each push
  // posts, so a summary rewrite that dropped an entry cannot change what the fixer is told.
  const entries = ownLedgerEntries(env.own);
  const blocking = reviewBlockingTriggers(env);
  const lineagePushes = lineagePushFacts(env.review.agreed, entries);
  const growth = await outsideDeclaredGrowth({
    ...(prdPath === undefined ? {} : { prdPath }),
    worktree: env.checkout.worktree,
    entries,
  });
  return {
    findingFacts: env.review.agreed.map((item) => ({
      id: item.key,
      lines: findingFactLines(item, entries, blocking),
    })),
    ...(lineagePushes.length === 0 ? {} : { lineagePushes }),
    ...(growth === undefined ? {} : { outsideGrowth: growth }),
  };
}

async function readFixHead(env: BotFixEnv): Promise<string | undefined> {
  try {
    return await _fixStepsDeps.readHead(env.checkout.worktree);
  } catch (error) {
    getLogger()?.warn("bot-fix", "Could not read HEAD after fix session", {
      pr: env.info.number,
      worktree: env.checkout.worktree,
      error: errorMessage(error),
    });
    return undefined;
  }
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
  const missing = !(await _fixStepsDeps.worktreeExists(env.checkout.worktree));
  getLogger()?.warn("bot-fix", missing ? "Fix checkout disappeared" : "Fix tree dirty; checkout retained", {
    pr: env.info.number,
    worktree: env.checkout.worktree,
  });
  return {
    patch: { outcome: "dirty", recoveryPath: env.checkout.worktree, ...(missing ? { checkoutMissing: true } : {}) },
    exit: "dirty",
  };
}

export async function checkStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  const unsafe = await unsafeTree(env, _state);
  if (unsafe) return unsafe;
  // changedPaths uses --no-renames: a move out of a protected directory is still a protected edit.
  const changed = await _fixStepsDeps.changedPaths(env.checkout.worktree, env.checkout.startHead ?? env.info.headSha);
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
  const tails = new Map<string, string>();
  const log = logGateFailure("fix");
  const result = await _fixStepsDeps.runQualityGates(env.checkout.worktree, worktreeCommands, {
    onGate: (record) => {
      log(record);
      tails.set(record.name, gateOutputTail(record.output));
    },
  });
  if (!result.passed) {
    // Snapshot the recoverable commit before baseline checkout can move HEAD.
    const fixSha = await _fixStepsDeps.readHead(env.checkout.worktree).catch((error) => {
      getLogger()?.warn("bot-fix", "Could not snapshot HEAD before baseline", { error: errorMessage(error) });
      return _state.fixSha;
    });
    const patch = {
      ...(await classifyRedGates(env, worktreeCommands, result.failing)),
      ...(fixSha !== undefined ? { fixSha } : {}),
    };
    const gateTails = result.failing.map((name) => ({ name, tail: tails.get(name) ?? "(no output captured)" }));
    return repairDecision(env, _state, { ...patch, gateTails });
  }
  return { patch: {}, exit: "passed" };
}

/** Classification, rounds and cost all constrain both repair-eligible outcomes. */
function repairDecision(env: BotFixEnv, state: BotFixState, patch: Partial<BotFixState>): StepResult<BotFixState> {
  const rounds = env.config.bot?.gateRepairRounds ?? DEFAULT_CONFIG.bot?.gateRepairRounds;
  const eligible =
    (state.gateRepairRounds ?? 0) < (rounds ?? 0) &&
    (patch.outcome === "gates-failed" || (patch.outcome === "baseline-red" && patch.ciOutcome === "green"));
  const belowLimit = env.cost.spentUsd() < env.cost.limitUsd;
  return {
    patch: { ...patch, ...(eligible && !belowLimit ? { repairSkippedForCost: true } : {}) },
    exit: eligible && belowLimit ? "repair" : "failed",
  };
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
    // Baseline checkout detaches HEAD; never move the user's in-place branch.
    checkout.inPlace
      ? undefined
      : _fixStepsDeps.failingOnHead(checkout.worktree, info.headSha, red).catch((err) => {
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
  if (env.checkout.inPlace) {
    const branch = await _fixStepsDeps.runGit(["symbolic-ref", "--short", "HEAD"], env.checkout.worktree);
    if (branch.exitCode !== 0 || branch.stdout.trim() !== env.info.headRef) {
      getLogger()?.warn("bot-fix", `In-place checkout left branch ${env.info.headRef}`);
      return { patch: { outcome: "push-rejected" }, exit: "rejected" };
    }
  }
  const unsafe = await unsafeTree(env, _state);
  if (unsafe) return unsafe;
  const result = await _fixStepsDeps.runGit(
    [
      "push",
      "--no-verify",
      `--force-with-lease=refs/heads/${env.info.headRef}:${env.info.headSha}`,
      "origin",
      `HEAD:refs/heads/${env.info.headRef}`,
    ],
    env.checkout.worktree,
    PUSH_TIMEOUT_MS,
  );
  if (result.timedOut) return { patch: { outcome: "push-unknown" }, exit: "rejected" };
  if (result.exitCode !== 0) return { patch: { outcome: "push-rejected" }, exit: "rejected" };
  const pushedSha = await _fixStepsDeps.readHead(env.checkout.worktree);
  return { patch: { pushedSha, outcome: _state.outcome === "nothing" ? "nothing" : "pushed" }, exit: "pushed" };
}
