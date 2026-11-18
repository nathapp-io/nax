/**
 * flow-handoff.ts — `nax-flow__send`'s handoff form: one feature this chat already ran,
 * handed to koda to publish and finish.
 *
 * The spec form sends specs that are not on any branch yet; this one sends a run that
 * already happened. `.nax/features/<feature>/workflow/` is git-excluded and lives only
 * on the machine that ran the chain, so the record travels with the request — and
 * every check koda would apply to it is applied here first, before anything is pushed.
 *
 * The order is the design's: parse, read the repository, check the branch, collect the
 * record, refuse a feature already handed over, use chain approval or ask the user, then run the same
 * post-allow sequence the spec form runs, and finally mark the run with what koda
 * answered. The mark is what stops a second local publisher (US-004).
 *
 * Every collaborator of the record and the mark is behind `_flowHandoffDeps`; the push,
 * the repository reads and the koda create stay on `_flowProviderDeps`.
 */
import type { ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { handoffMarkRefusal, readNewestHandoffMark, writeHandoffMark } from "../../workflow/handoff-mark";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { collectHandoffRecord, type HandoffRecordFile, type HandoffRecordRead } from "../../workflow/handoff-record";
// biome-ignore lint/style/noRestrictedImports: workflow barrel closes a runtime cycle.
import { workflowFeatureDir, workflowRunDir } from "../../workflow/paths";
import type { HostApprovalCard } from "../ask-controller";
import type { ChainAdmission, ChatChains } from "../jobs";
import { _flowProviderDeps } from "./flow-deps";
import { type FlowHandoffInput, handoffStepArgv, parseFlowHandoffInput } from "./flow-handoff-input";
import { isRecord } from "./flow-input";
import type { FlowHandoffCreateBody } from "./flow-koda";
import { checkFlowBranch, type FlowRepoReady } from "./flow-repo";
import {
  afterAllow,
  BILLING_NOTE,
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
} from "./flow-send-steps";

/**
 * The mark's shape, as the workflow writer declares it — named here so the send does
 * not restate a schema it only passes through.
 */
type HandoffMark = Parameters<typeof writeHandoffMark>[1];

/**
 * The record and the mark, and the clock the mark's timestamp comes from. Stubbed in
 * tests so a run directory, a git repository and a koda server are all unnecessary.
 */
export const _flowHandoffDeps: {
  collectHandoffRecord: typeof collectHandoffRecord;
  readNewestHandoffMark: typeof readNewestHandoffMark;
  writeHandoffMark: typeof writeHandoffMark;
  now: () => Date;
} = { collectHandoffRecord, readNewestHandoffMark, writeHandoffMark, now: () => new Date() };

/** The record the preflights accepted, and the repository state they read it at. */
interface HandoffReady {
  readonly ok: true;
  readonly state: FlowRepoReady;
  readonly collected: Extract<HandoffRecordRead, { ok: true }>;
}

/** What the local checks leave behind, or the result that stops the send. */
type HandoffPreflight = HandoffReady | { readonly ok: false; readonly result: ToolResult };

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
    `cost cap $${input.costCapUsd.toFixed(2)}`,
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
 * The local checks a handoff runs before the card, in the design's order: the request,
 * the repository (branch, clean tree, head, GitHub remote — read with no spec paths,
 * because a handoff sends none), koda's branch rules, the record and the PRD, and a
 * mark already on the newest run.
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
  return { ok: true, state, collected };
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
function refusedHandoff(result: ToolResult, feature: unknown, chains?: ChatChains): ToolResult {
  if (!chains || typeof feature !== "string") return result;
  const active = chains.active();
  if (!active) return result;
  const next = chains.summary()?.next;
  const step = next === undefined ? undefined : active.steps[next - 1];
  if (step?.kind === "handoff" && step.target === feature) chains.stop(result.content.replace(/^\[chat\] /, ""));
  return result;
}

async function sendApprovedHandoff(
  call: {
    readonly input: FlowHandoffInput;
    readonly ready: HandoffReady;
    readonly signal?: AbortSignal;
    readonly auto?: Extract<ChainAdmission, { kind: "auto" }>;
  },
  options: FlowProviderOptions,
): Promise<ToolResult> {
  const {
    input,
    ready: { state, collected },
    signal,
    auto,
  } = call;
  let result: ToolResult | undefined;
  let succeeded = false;
  try {
    const allow = { state, specPaths: [], body: createBody(state, input, collected.record), signal };
    const post = await afterAllow(allow, options);
    const mark = markOf(post, _flowHandoffDeps.now().toISOString(), options.connection.url);
    const runDir = workflowRunDir(options.repoRoot, input.feature, collected.newestRunId);
    result = mark === undefined ? post.result : await markRun(runDir, mark, input.feature, post.result);
    succeeded = post.created !== undefined;
    return result;
  } catch (error) {
    result = sendFailure(error);
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
  const ready = await preflight(parsed, options.repoRoot);
  if (!ready.ok) return refusedHandoff(ready.result, parsed.feature, options.chains);

  const admission = options.chains?.admit({ kind: "handoff", argv: handoffStepArgv(parsed) });
  if (admission?.kind === "auto")
    return sendApprovedHandoff({ input: parsed, ready, signal, auto: admission }, options);
  const decision = await options.approve(approvalCard(ready, parsed, { signal, note: admission?.note }));
  if (decision === "deny") return failure(DECLINED_MESSAGE);
  return sendApprovedHandoff({ input: parsed, ready, signal }, options);
}
