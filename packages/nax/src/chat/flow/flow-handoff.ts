/**
 * flow-handoff.ts — `nax-flow__send`'s handoff form: one feature this chat already ran,
 * handed to koda to publish and finish.
 *
 * The spec form sends specs that are not on any branch yet; this one sends a run that
 * already happened. `.nax/features/<feature>/workflow/` is git-excluded and lives only
 * on the machine that ran the chain, so the record travels with the request — and
 * every check koda would apply to it is applied here first, before anything is pushed.
 *
 * The order is the design's: parse, read the repository, check the branch, collect the record, refuse
 * a feature already handed over, refuse a branch that already has an open PR, use chain approval or
 * ask the user, then run the same post-allow sequence the spec form runs, and finally mark the run
 * with what koda answered. The mark is what stops a second local publisher (US-004). The open-PR check
 * runs twice — before the card and again inside the handoff lock at the push boundary — because a PR
 * can appear over the approval window, and a forge that cannot answer is a refusal, never a green
 * light.
 *
 * Approval opens a window the local checks have already closed: the record and the mark are re-read
 * after it, the mark, the open PR and the result listing are checked again at the push boundary, and
 * the whole mark-to-mark sequence of one feature is serialized across processes and against result
 * writers. So a handoff that finished while this one was waiting is seen before anything is pushed,
 * and a cancelled turn stops waiting.
 *
 * Every collaborator of the record, the mark and the forge answer is behind `_flowHandoffDeps`; the
 * push, the repository reads and the koda create stay on `_flowProviderDeps`.
 */
import type { ToolResult } from "@nathapp/nax-agent";
import { errorMessage, withFileLock } from "@nathapp/nax-agent/internal";
import { defaultForgeDeps, hasOpenPr } from "@/forge";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { handoffMarkRefusal, readNewestHandoffMark, readRunMark, writeHandoffMark } from "../../workflow/handoff-mark";
// biome-ignore-start lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import {
  collectHandoffRecord,
  type HandoffRecordFile,
  type HandoffRecordRead,
  handoffResultsMatch,
} from "../../workflow/handoff-record";
// biome-ignore-end lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { handoffLockPath, workflowFeatureDir, workflowRunDir } from "../../workflow/paths";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { restorePendingResults } from "../../workflow/result-recovery";
import type { HostApprovalCard } from "../ask-controller";
import type { ChainAdmission, ChatChains } from "../jobs";
import { _flowProviderDeps } from "./flow-deps";
import {
  type FlowHandoffInput,
  formatHandoffCostCap,
  handoffStepArgv,
  parseFlowHandoffInput,
} from "./flow-handoff-input";
import { isRecord } from "./flow-input";
import type { FlowHandoffCreateBody } from "./flow-koda";
import { checkFlowBranch, type FlowRepoReady, githubRepoSlug } from "./flow-repo";
import {
  afterAllow,
  BILLING_NOTE,
  CANCELLED_MESSAGE,
  cardedRepoLine,
  cardText,
  DECLINED_MESSAGE,
  type FlowProviderOptions,
  failure,
  flowLink,
  inputFailure,
  type PostAllowResult,
  sendFailure,
  TOOL_NAME,
  turnCancelled,
} from "./flow-send-steps";

/**
 * The mark's shape, as the workflow writer declares it — named here so the send does
 * not restate a schema it only passes through.
 */
type HandoffMark = Parameters<typeof writeHandoffMark>[1];

/**
 * The record, the mark, the forge's open-PR answer and the recovery replay, and the clock the mark's
 * timestamp comes from. Stubbed in tests so a run directory, a git repository, a forge login and a koda
 * server are all unnecessary.
 */
export const _flowHandoffDeps: {
  collectHandoffRecord: typeof collectHandoffRecord;
  handoffResultsMatch: typeof handoffResultsMatch;
  readNewestHandoffMark: typeof readNewestHandoffMark;
  readRunMark: typeof readRunMark;
  writeHandoffMark: typeof writeHandoffMark;
  withFileLock: typeof withFileLock;
  hasOpenPr: (branch: string, repo: string, repoRoot: string) => Promise<boolean>;
  restorePendingResults: typeof restorePendingResults;
  now: () => Date;
} = {
  collectHandoffRecord,
  handoffResultsMatch,
  readNewestHandoffMark,
  readRunMark,
  writeHandoffMark,
  withFileLock,
  // A chat handoff accepts only a GitHub `origin` (`readFlowRepoState`), so the forge is always GitHub —
  // and the repository is the one the card and the push name, never whichever repository the CLI would
  // resolve from its own environment.
  hasOpenPr: (branch: string, repo: string, repoRoot: string) =>
    hasOpenPr("github", branch, defaultForgeDeps, repoRoot, repo),
  restorePendingResults,
  now: () => new Date(),
};

/** The record the preflights accepted, and the repository state they read it at. */
interface HandoffReady {
  readonly ok: true;
  readonly state: FlowRepoReady;
  readonly collected: Extract<HandoffRecordRead, { ok: true }>;
}

/** What the local checks leave behind, or the result that stops the send. */
type HandoffPreflight = HandoffReady | { readonly ok: false; readonly result: ToolResult };

/** One handoff that was let through: what was carded, the turn's cancellation, and its chain step. */
interface SendCall {
  readonly input: FlowHandoffInput;
  readonly ready: HandoffReady;
  readonly signal?: AbortSignal;
  readonly auto?: Extract<ChainAdmission, { kind: "auto" }>;
}

/** What one approved handoff left: the result to report, and whether koda holds a flow for it. */
interface CreatedHandoff {
  readonly result: ToolResult;
  /** True only for a created or held answer, which is the outcome a chain step reports as succeeded. */
  readonly created: boolean;
}

/** The distinct runs the record carries: koda bounds runs, not files. */
function runCount(record: readonly HandoffRecordFile[]): number {
  return new Set(record.map((entry) => entry.runId)).size;
}

/** The UTF-8 size of everything the handoff uploads, which is what koda's cap measures. */
function recordBytes(record: readonly HandoffRecordFile[]): number {
  return record.reduce((total, entry) => total + Buffer.byteLength(entry.content, "utf8"), 0);
}

/** One line naming the feature and the record: how many runs it carries, and how big it is. */
function recordLine(input: FlowHandoffInput, record: readonly HandoffRecordFile[]): string {
  return `feature ${cardText(input.feature)}: ${runCount(record)} run(s), ${recordBytes(record)} bytes of run record`;
}

/** What the user is agreeing to: repository, record, roles, cap and koda's own approval. */
function cardReason(state: FlowRepoReady, input: FlowHandoffInput, record: readonly HandoffRecordFile[]): string {
  return [
    cardedRepoLine(state),
    recordLine(input, record),
    `reviewer ${cardText(input.roles.reviewer)}, supervisor ${cardText(input.roles.supervisor)}`,
    `cost cap $${formatHandoffCostCap(input.costCapUsd)}`,
    BILLING_NOTE,
  ].join("\n");
}

/** A handoff without matching chain approval still shows a card in every chat mode. */
function approvalCard(
  { state, collected }: HandoffReady,
  input: FlowHandoffInput,
  { signal, note }: { readonly signal?: AbortSignal; readonly note?: string },
): HostApprovalCard {
  const reason = cardReason(state, input, collected.record);
  return {
    tool: TOOL_NAME,
    summary: `hand ${input.feature} over to koda`,
    command: `git push --set-upstream origin ${state.branch}`,
    reason: note === undefined ? reason : `${reason}\n${note}`,
    signal,
  };
}

/** The koda body: the pushed branch, the roles as given, and the record that only exists here. */
function createBody(
  state: FlowRepoReady,
  input: FlowHandoffInput,
  record: readonly HandoffRecordFile[],
): FlowHandoffCreateBody {
  return {
    remoteUrl: state.remoteUrl,
    branch: state.branch,
    roles: input.roles,
    costCapUsd: input.costCapUsd,
    handoff: { feature: input.feature, headSha: state.sha, record },
  };
}

/**
 * The open-PR check, as the result that stops the send — or nothing when the branch has no PR.
 *
 * A handoff asks koda to own a feature from a branch koda opens the PR for, so a branch that already
 * carries an open PR belongs to someone else's publish. A forge that cannot answer is a refusal too,
 * never a green light: treating a failed `gh` as "no PR" is what let two publishers each open one, so
 * the failure is reported with the same weight as the PR itself.
 *
 * The check names the repository the card names, which is the repository the push destination is
 * verified against. A bare branch name is not enough: the CLI resolves its own repository from
 * `GH_REPO` or the working directory, so a checkout whose default differs from the push destination
 * could report an empty list from another repository and authorize a push the destination's open PR
 * should have refused.
 *
 * @param feature - The feature being handed off, named in the refusal
 * @param state - The repository state the card was built from: the branch to push and its GitHub remote
 * @param repoRoot - The directory the forge is run in
 * @returns The `[chat]` result to stop with, or `undefined` when the branch has no open PR
 */
async function openPrRefusal(feature: string, state: FlowRepoReady, repoRoot: string): Promise<ToolResult | undefined> {
  const repo = githubRepoSlug(state.remoteUrl);
  if (repo === null) {
    return failure(
      `[chat] cannot hand off ${feature}: could not check branch ${state.branch} for an open PR (${state.remoteUrl} is not a GitHub repository the check can name); nothing was pushed`,
    );
  }
  let open: boolean;
  try {
    open = await _flowHandoffDeps.hasOpenPr(state.branch, repo, repoRoot);
  } catch (error) {
    return failure(
      `[chat] cannot hand off ${feature}: could not check branch ${state.branch} for an open PR (${errorMessage(error)}); nothing was pushed`,
    );
  }
  return open
    ? failure(
        `[chat] cannot hand off ${feature}: branch ${state.branch} already has an open PR; a handoff needs a branch with no PR`,
      )
    : undefined;
}

/**
 * The local checks a handoff runs before the card, in the design's order: the request,
 * the repository (branch, clean tree, head, GitHub remote — read with no spec paths,
 * because a handoff sends none), koda's branch rules, the record and the PRD, a
 * mark already on the newest run, and whether the branch already has an open PR.
 *
 * The PR check is last: a feature handed over already has its PR opened by koda, and its user
 * needs the mark refusal — naming what koda holds — rather than a second refusal about a PR that
 * exists because of the handoff.
 *
 * @param input - The parsed handoff request
 * @param repoRoot - The chat's repository root
 * @returns The state and the record, or the `[chat]` result that stops the send
 */
async function preflight(input: FlowHandoffInput, repoRoot: string): Promise<HandoffPreflight> {
  const state = await _flowProviderDeps.readFlowRepoState(repoRoot, []);
  if (!state.ok) return { ok: false, result: failure(state.message) };
  const branch = checkFlowBranch(state.branch, []);
  if (branch !== undefined) return { ok: false, result: failure(branch) };
  const collected = await _flowHandoffDeps.collectHandoffRecord({
    repoRoot,
    feature: input.feature,
    head: state.sha,
    branch: state.branch,
  });
  if (!collected.ok) {
    return { ok: false, result: failure(`[chat] cannot hand off ${input.feature}: ${collected.reason}`) };
  }
  const marked = await _flowHandoffDeps.readNewestHandoffMark(workflowFeatureDir(repoRoot, input.feature));
  if (marked !== null) return { ok: false, result: failure(`[chat] ${handoffMarkRefusal(input.feature, marked)}`) };
  const openPr = await openPrRefusal(input.feature, state, repoRoot);
  if (openPr !== undefined) return { ok: false, result: openPr };
  return { ok: true, state, collected };
}

/**
 * `preflight`, with a thrown local check reported as a refused send.
 *
 * A filesystem refusal a chain cannot see — a run directory that vanished, a link a run's own
 * record may not point at — reaches the user as the same `[chat] flow send failed:` line. Left to
 * throw, it would escape the chain's matching-refusal handler, so a chain waiting for this
 * feature's handoff would sit waiting for a step that will never run.
 *
 * @param input - The parsed handoff request
 * @param repoRoot - The chat's repository root
 * @returns The state and the record, or the `[chat]` result that stops the send
 */
async function preflightOrRefusal(input: FlowHandoffInput, repoRoot: string): Promise<HandoffPreflight> {
  try {
    return await preflight(input, repoRoot);
  } catch (error) {
    return { ok: false, result: sendFailure(error) };
  }
}

/**
 * The mark the answer earns: the created flow with the link koda's own UI serves it
 * from, the approval request holding the create, or — when the push happened but the
 * answer never arrived — that the outcome is unknown. A refusal earns no mark.
 *
 * @param post - What the allow bought
 * @param at - The injected clock's instant, as the ISO timestamp the mark records
 * @param kodaUrl - The koda API root the flow's relative link is joined onto
 * @returns The mark to write, or undefined when nothing was created or left unknown
 */
function markOf(post: PostAllowResult, at: string, kodaUrl: string): HandoffMark | undefined {
  if (post.created !== undefined) {
    return post.created.kind === "held"
      ? { schemaVersion: 1, at, requestId: post.created.requestId }
      : { schemaVersion: 1, at, flowId: post.created.id, url: flowLink(kodaUrl, post.created.url) };
  }
  return post.unknown === true ? { schemaVersion: 1, at, outcomeUnknown: true } : undefined;
}

/**
 * Mark the newest run, and report why not when the mark could not be written.
 *
 * A failed write never changes the result: koda may hold the flow already, and a tool
 * result that called it a failure would invite a second send. It appends what the
 * user needs instead — nothing now stops a local publish of the feature.
 *
 * @param runDir - The newest run's directory, where the mark belongs
 * @param mark - What koda answered
 * @param feature - The feature, named in the appended sentence
 * @returns The result to report, with the failure appended when the write failed
 */
async function markRun(runDir: string, mark: HandoffMark, feature: string, result: ToolResult): Promise<ToolResult> {
  try {
    await _flowHandoffDeps.writeHandoffMark(runDir, mark);
    return result;
  } catch (error) {
    const why = errorMessage(error);
    return {
      ...result,
      content: `${result.content}; the local handoff mark could not be written (${why}), so nothing stops a local publish of ${feature}`,
    };
  }
}

/** A pre-admission refusal stops only a chain waiting for this feature's handoff. */
export function refusedHandoff(result: ToolResult, feature: unknown, chains?: ChatChains): ToolResult {
  if (!chains || typeof feature !== "string") return result;
  const active = chains.active();
  if (!active) return result;
  const next = chains.summary()?.next;
  const step = next === undefined ? undefined : active.steps[next - 1];
  if (step?.kind === "handoff" && step.target === feature) chains.stop(result.content.replace(/^\[chat\] /, ""));
  return result;
}

/** Nothing was pushed: the record that was approved is no longer the one on disk. */
const RECORD_CHANGED_MESSAGE = "[chat] the run record changed while the card was open; nothing was pushed";

/** Whether two entries describe the same file of the same run, as it was when it was read. */
function sameEntry(approved: HandoffRecordFile, reread: HandoffRecordFile | undefined): boolean {
  return (
    reread !== undefined &&
    approved.runId === reread.runId &&
    approved.file === reread.file &&
    approved.mtimeMs === reread.mtimeMs &&
    approved.content === reread.content
  );
}

/** Whether the re-read record is the one the user approved: same newest run, same files, same text. */
function sameRecord(approved: HandoffReady["collected"], reread: Extract<HandoffRecordRead, { ok: true }>): boolean {
  if (approved.newestRunId !== reread.newestRunId || approved.record.length !== reread.record.length) return false;
  return approved.record.every((entry, index) => sameEntry(entry, reread.record[index]));
}

/** The cancelled result, or undefined while the turn is live. Read through a call, never narrowed. */
function cancellationRefusal(signal: AbortSignal | undefined): ToolResult | undefined {
  return turnCancelled(signal) ? failure(CANCELLED_MESSAGE) : undefined;
}

/**
 * The approval covered one run's record at one mark state, and the user may have taken minutes
 * over it. Both are re-read here, before anything is pushed: a mark that appeared while the card was
 * open means koda may already hold the feature, and a newer run — or a changed record — means the mark
 * this send would write no longer sits on the run the local publish guards consult. Either way nothing
 * the user did not approve is transferred.
 *
 * The cancellation is read before and between the two reads: a turn the user has already abandoned is
 * answered with the cancel the spec's table requires, not with a refusal about a record nothing will
 * be sent from, and its whole record is not read for nothing.
 *
 * @param call - The parsed handoff, the carded state and record, and the turn's cancellation
 * @param options - The chat's repository
 * @returns The `[chat]` result to stop with, or `undefined` when the approved record is still the one there
 */
async function approvalRefusal(call: SendCall, options: FlowProviderOptions): Promise<ToolResult | undefined> {
  const { input, ready, signal } = call;
  const beforeChecks = cancellationRefusal(signal);
  if (beforeChecks !== undefined) return beforeChecks;
  const marked = await _flowHandoffDeps.readNewestHandoffMark(workflowFeatureDir(options.repoRoot, input.feature));
  const afterMark = cancellationRefusal(signal);
  if (afterMark !== undefined) return afterMark;
  if (marked !== null) return failure(`[chat] ${handoffMarkRefusal(input.feature, marked)}`);
  const reread = await _flowHandoffDeps.collectHandoffRecord({
    repoRoot: options.repoRoot,
    feature: input.feature,
    head: ready.state.sha,
    branch: ready.state.branch,
  });
  const afterRecord = cancellationRefusal(signal);
  if (afterRecord !== undefined) return afterRecord;
  if (!reread.ok) return failure(`[chat] cannot hand off ${input.feature}: ${reread.reason}`);
  return sameRecord(ready.collected, reread) ? undefined : failure(RECORD_CHANGED_MESSAGE);
}

/**
 * The post-card re-check, with a cancelled turn answered by the cancel whatever it interrupts. The
 * record read is the long one, so an already-cancelled turn must not enter it, and an interrupted one
 * must not report the filesystem error it hit as a failed send instead of a cancel.
 *
 * @param call - The parsed handoff, the carded state and record, and the turn's cancellation
 * @param options - The chat's repository
 * @returns The `[chat]` result to stop with, or `undefined` when the send may go on
 */
async function recheck(call: SendCall, options: FlowProviderOptions): Promise<ToolResult | undefined> {
  const cancelRefusal = cancellationRefusal(call.signal);
  if (cancelRefusal !== undefined) return cancelRefusal;
  try {
    return await approvalRefusal(call, options);
  } catch (error) {
    if (!turnCancelled(call.signal)) throw error;
    return failure(CANCELLED_MESSAGE);
  }
}

/**
 * The last checks before the push: the run this send will mark is still unmarked, the turn is live,
 * the branch still has no open PR, and the verified run's results still match the carded record.
 *
 * The PR check sits here — after the run-mark read and the cancellation, and before the results
 * match — because this is the last forge read before the push, under the handoff lock, and the
 * approval window is long enough for a PR to appear in it.
 */
async function handoffPushGuard(call: SendCall, options: FlowProviderOptions): Promise<ToolResult | undefined> {
  const { input, ready, signal } = call;
  const runDir = workflowRunDir(options.repoRoot, input.feature, ready.collected.newestRunId);
  const found = await _flowHandoffDeps.readRunMark(runDir);
  if (found !== null) return failure(`[chat] ${handoffMarkRefusal(input.feature, found)}`);
  const cancelled = cancellationRefusal(signal);
  if (cancelled !== undefined) return cancelled;
  const openPr = await openPrRefusal(input.feature, ready.state, options.repoRoot);
  if (openPr !== undefined) return openPr;
  const workflowDir = workflowFeatureDir(options.repoRoot, input.feature);
  const matches = await _flowHandoffDeps.handoffResultsMatch(workflowDir, options.repoRoot, ready.collected);
  return matches ? undefined : failure(RECORD_CHANGED_MESSAGE);
}

/**
 * Everything one approved handoff does after the allow: the re-check, the push, the flow, the mark.
 *
 * The first thing it does is replay the recovery files a run-end or crash repair deferred (#2984): those
 * repairs cannot wait for this lock, so a `result.json` they could not restore is kept beside itself and
 * this lock-take applies it — before the recheck reads the record, so the record compared is the one on
 * disk rather than the damaged or missing bytes the repair saw.
 *
 * @param call - The parsed handoff, the carded state and record, and the turn's cancellation
 * @param options - The chat's repository, its koda server and the chain it answers to
 * @returns The result to report and whether koda holds a flow, or the refusal that stopped the send
 */
async function handOver(call: SendCall, options: FlowProviderOptions): Promise<CreatedHandoff> {
  const { input, ready, signal } = call;
  const { state, collected } = ready;
  try {
    await _flowHandoffDeps.restorePendingResults(workflowFeatureDir(options.repoRoot, input.feature));
    const refused = await recheck(call, options);
    if (refused !== undefined) return { result: refused, created: false };
    const beforePush = () => handoffPushGuard(call, options);
    const allow = { state, specPaths: [], body: createBody(state, input, collected.record), signal, beforePush };
    const post = await afterAllow(allow, options);
    const mark = markOf(post, _flowHandoffDeps.now().toISOString(), options.connection.url);
    const runDir = workflowRunDir(options.repoRoot, input.feature, collected.newestRunId);
    const result = mark === undefined ? post.result : await markRun(runDir, mark, input.feature, post.result);
    return { result, created: post.created !== undefined };
  } catch (error) {
    return { result: sendFailure(error), created: false };
  }
}

async function sendApprovedHandoff(call: SendCall, options: FlowProviderOptions): Promise<ToolResult> {
  const { input, auto, signal } = call;
  let result: ToolResult | undefined;
  let succeeded = false;
  try {
    // The workflow directory already exists after preflight and is ignored by git. Hold the
    // lock from the post-approval recheck through the mark write, even during cancellation.
    const lockPath = handoffLockPath(workflowFeatureDir(options.repoRoot, input.feature));
    const outcome = await _flowHandoffDeps.withFileLock(lockPath, () => handOver(call, options), {
      lockName: "handoff",
      errorPrefix: "[chat]",
      signal,
    });
    result = outcome.result;
    succeeded = outcome.created;
    return result;
  } catch (error) {
    result = cancellationRefusal(signal) ?? sendFailure(error);
    return result;
  } finally {
    if (auto !== undefined) {
      options.chains?.stepEnded(
        auto.chainId,
        auto.step,
        succeeded ? "succeeded" : "failed",
        result?.content ?? "flow send failed",
      );
    }
  }
}

/** Run the local checks, use the chain approval or a direct card, then send and mark the handoff. */
export async function sendFlowHandoff(
  request: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: FlowProviderOptions,
): Promise<ToolResult> {
  const parsed = parseFlowHandoffInput(request);
  if ("errors" in parsed) {
    const feature = isRecord(request.handoff) ? request.handoff.feature : undefined;
    return refusedHandoff(inputFailure(parsed.errors), feature, options.chains);
  }
  const ready = await preflightOrRefusal(parsed, options.repoRoot);
  if (!ready.ok) return refusedHandoff(ready.result, parsed.feature, options.chains);

  const admission = options.chains?.admit({ kind: "handoff", argv: handoffStepArgv(parsed) });
  if (admission?.kind === "auto")
    return sendApprovedHandoff({ input: parsed, ready, signal, auto: admission }, options);
  const decision = await options.approve(approvalCard(ready, parsed, { signal, note: admission?.note }));
  if (decision === "deny") return failure(DECLINED_MESSAGE);
  return sendApprovedHandoff({ input: parsed, ready, signal }, options);
}
