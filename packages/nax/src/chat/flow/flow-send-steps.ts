/**
 * flow-send-steps.ts — what both forms of `nax-flow__send` do after their card.
 *
 * A spec-form send and a handoff send differ in what they check before the card and
 * in the body koda is sent; everything after the card is the same sequence — the
 * commit and tree re-check, the push target, the push destination, the pinned push
 * and the koda create. It lives here so neither form restates it, and so the handoff
 * — which the provider routes to before any parse — never has to import the provider.
 *
 * The steps return `PostAllowResult`: the result every caller reports, plus what koda
 * answered when it answered. The spec form uses only the result; the handoff needs the
 * answer, and whether it was lost after the push, to write the run's handoff mark.
 */
import type { ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { kodaStatusOf } from "@/memory";
import type { HostApprovalCard } from "../ask-controller";
import type { ChatChains } from "../jobs";
import type { KodaFlowConnection } from "./flow-connection";
import { _flowProviderDeps } from "./flow-deps";
import type { FlowCreateBody, FlowCreateOutcome, FlowHandoffCreateBody } from "./flow-koda";
import { type FlowRepoReady, normalizeGitHubRemote } from "./flow-repo";

/** The commit message `commitAndPush` takes; with `skipCommit` nothing is committed, so it is never used. */
export const FLOW_PUSH_COMMIT_MESSAGE = "chore: send flow to koda";
/** The qualified tool name, as the card names it. */
export const TOOL_NAME = "nax-flow__send";
/** The card names the commit by its first characters; the push and the request carry it whole. */
const CARDED_SHA_CHARS = 8;
/** The one sentence both the card's last line and the created result's second line carry. */
export const BILLING_NOTE = "koda will ask you to approve this flow before anything billed starts";
/** The declined result, matching the jobs tools' wording: a denial is final for that call. */
export const DECLINED_MESSAGE =
  "[chat] the user declined sending the flow to koda; do not retry with different arguments unless the user asks";
/** Nothing was pushed: the commit the card described is no longer the one the branch is on. */
export const BRANCH_CHANGED_MESSAGE = "[chat] the branch changed while the card was open; nothing was pushed";
/** HTTPS only: stripping userinfo must never upgrade HTTP during verification. */
const HTTPS_USERINFO_PREFIX = /^https:\/\/[^/@]+@/i;
/** Nothing was pushed: the branch or the origin the push would resolve is no longer the one carded. */
export const PUSH_TARGET_MOVED_MESSAGE =
  "[chat] the branch or origin being pushed changed while the card was open; nothing was pushed";
/** Nothing was pushed: the turn was cancelled between the card and the push. */
export const CANCELLED_MESSAGE = "[chat] the turn was cancelled; nothing was pushed";
/**
 * Anything that can break a card line, reorder what is printed after it or move the
 * cursor. `\p{Cc}` is the Unicode control category (C0 and C1) and `\p{Cf}` the
 * format category, which is where the bidirectional overrides live (U+202A–U+202E,
 * U+2066–U+2069, U+200E/U+200F, U+061C). A committed file name is the one carded
 * value the request rules let carry them.
 */
const CARD_ESCAPED_CHARS = /[\p{Cc}\p{Cf}]/gu;
/** A `\uXXXX` escape is four hexadecimal digits. */
const UNICODE_ESCAPE_DIGITS = 4;
/** The highest code point a bare `\uXXXX` escape can name; above it the braced form is used. */
const MAX_BASIC_PLANE_CODE_POINT = 0xffff;

/** Where a flow send runs: the repository it pushes and the koda server it creates in. */
export interface FlowSendTarget {
  /** The chat's repository root: what is pushed and what koda is told about. */
  readonly repoRoot: string;
  /** The koda API root and headers the flow is created through. */
  readonly connection: KodaFlowConnection;
}

/**
 * The options the tool is built with. It lives here, beside the steps that consume the
 * target, so the handoff send shares one options type with the provider.
 */
export interface FlowProviderOptions extends FlowSendTarget {
  readonly chains?: ChatChains;
  /** Puts the card in front of the user; the host's `requestHostApproval` in practice. */
  readonly approve: (card: HostApprovalCard) => Promise<"allow" | "deny">;
}

/** What the allow bought: the result to report, and what koda answered when it answered. */
export interface PostAllowResult {
  /** What the tool returns, whatever the form asked for. */
  readonly result: ToolResult;
  /** Set on a 201 or 202 answer: koda created the flow, or is holding the create. */
  readonly created?: FlowCreateOutcome;
  /** Set when the push happened and koda's answer was lost or unusable, so the flow may exist. */
  readonly unknown?: true;
}

/** Everything the allow buys, as the request that was carded described it. */
export interface FlowAllowRequest {
  /** The repository state the card was built from. */
  readonly state: FlowRepoReady;
  /** The spec paths the push-target re-read resolves; empty for a handoff, which sends none. */
  readonly specPaths: readonly string[];
  /** The body koda is sent once the branch is pushed. */
  readonly body: FlowCreateBody | FlowHandoffCreateBody;
  /** The turn's cancellation. */
  readonly signal?: AbortSignal;
  /**
   * A form's own last check, run at the push boundary inside everything that already serializes the
   * push: the handoff re-reads its mark here, so a send that finished during the checks above is seen
   * before anything leaves the machine. Absent for the spec form, whose checks end above.
   */
  readonly beforePush?: () => Promise<ToolResult | undefined>;
  /** In-memory admission check: no await between this check and the invocation of the push. */
  readonly atPush?: () => ToolResult | undefined;
}

/** A koda failure its contract classifies: the message, and whether the flow may exist anyway. */
interface ClassifiedKodaFailure {
  /** The `[chat]` message the user reads. */
  readonly message: string;
  /** True when the push happened and koda may hold the flow: only a lost or unusable answer says that. */
  readonly unknown: boolean;
}

/**
 * One code point as a readable escape: `\uXXXX` inside the basic plane, and the
 * braced `\u{XXXXX}` form above it. The regex matches a whole code point, not a
 * UTF-16 code unit, so reading only the first unit would render every
 * supplementary-plane character that shares a high surrogate — U+1D173 and
 * U+1D174 among the format characters — as the same escape, and two distinct
 * paths would look identical on the card.
 */
function unicodeEscape(char: string): string {
  const codePoint = char.codePointAt(0) ?? 0;
  const hex = codePoint.toString(16).padStart(UNICODE_ESCAPE_DIGITS, "0");
  return codePoint > MAX_BASIC_PLANE_CODE_POINT ? `\\u{${hex}}` : `\\u${hex}`;
}

/**
 * One carded value as the card shows it: control and format characters escaped, so
 * a value carrying a newline, a bidirectional override or an escape sequence — a
 * committed file name is the one that can — cannot forge an extra card line,
 * reorder the text around it or move the cursor while the user reads what they are
 * approving. The request body keeps the literal value.
 */
export function cardText(value: string): string {
  return value.replace(CARD_ESCAPED_CHARS, unicodeEscape);
}

/** The card's first line: the repository, the branch and the commit it was read at. */
export function cardedRepoLine(state: FlowRepoReady): string {
  return `repo ${cardText(state.remoteUrl)} on branch ${cardText(state.branch)} at ${state.sha.slice(0, CARDED_SHA_CHARS)}`;
}

/** A failed run: one `[chat]` line, never a throw. */
export function failure(content: string): ToolResult {
  return { isError: true, content };
}

/** An unclassified throw is reported the same way by either form of send. */
export function sendFailure(error: unknown): ToolResult {
  return failure(`[chat] flow send failed: ${errorMessage(error)}`);
}

/** A request that broke a rule: every error listed, nothing pushed. */
export function inputFailure(errors: readonly string[]): ToolResult {
  return failure(`[chat] the flow request is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

/** Whether the turn was cancelled. Read through a call so a check made earlier cannot narrow a later one. */
export function turnCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Whether the branch no longer holds the commit the card described, or gained changes since. */
async function branchMoved(state: FlowRepoReady, repoRoot: string): Promise<boolean> {
  if ((await _flowProviderDeps.headSha(repoRoot)) !== state.sha) return true;
  return await _flowProviderDeps.isDirty(repoRoot);
}

/**
 * The state the push will actually resolve, read again at the push boundary.
 *
 * `branchMoved` answers the brief's narrower question — the commit and the tree.
 * The push, though, resolves `refs/heads/<branch>` and `origin` by name at the
 * moment it runs, so the branch that is about to be pushed, its commit, the
 * origin it goes to and the specs at that commit are verified together here: a
 * checkout moved to another branch holding the same commit, or a remote repointed
 * while the card was open, fails with nothing pushed.
 *
 * @param state - The repository state the card was built from
 * @param specPaths - The specs to resolve at that commit; empty when the form sends none
 * @param repoRoot - The repository to read
 * @returns The `[chat]` result to stop with, or `undefined` when the target is still the carded one
 */
async function pushTargetFailure(
  state: FlowRepoReady,
  specPaths: readonly string[],
  repoRoot: string,
): Promise<ToolResult | undefined> {
  const now = await _flowProviderDeps.readFlowRepoState(repoRoot, specPaths);
  if (!now.ok) return failure(now.message);
  const unchanged = now.branch === state.branch && now.sha === state.sha && now.remoteUrl === state.remoteUrl;
  return unchanged ? undefined : failure(PUSH_TARGET_MOVED_MESSAGE);
}

/**
 * The repository a push URL targets, tolerating a credential in it.
 *
 * A configured push URL routinely carries its own authentication — an SSH address
 * whose user is part of the address, or an HTTPS URL with a token in front of the
 * host — and neither stops the URL naming the carded repository. Only the
 * repository identity is compared here; the URL itself is used verbatim, so its
 * transport keeps working.
 */
function pushRepositoryOf(pushUrl: string): string | null {
  return normalizeGitHubRemote(pushUrl) ?? normalizeGitHubRemote(pushUrl.replace(HTTPS_USERINFO_PREFIX, "https://"));
}

/** The verified destination the push is addressed to, or the result that stops the send. */
type PushDestination =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly result: ToolResult };

/**
 * Where this push will actually go, and whether it is still the carded repository.
 *
 * A remote's push URL can differ from the fetch URL the card and the koda body were
 * built from (`remote.origin.pushurl`, `url.<base>.pushInsteadOf`), so it is read on
 * its own and compared with the carded repository: pushing a flow's branch somewhere
 * the card did not name would send koda to read a repository that never received it.
 * The URL is then handed to the push itself, so git does not resolve `origin` a
 * second time.
 *
 * @param state - The repository state the card was built from
 * @param repoRoot - The repository to read
 */
async function pushDestination(state: FlowRepoReady, repoRoot: string): Promise<PushDestination> {
  const read = await _flowProviderDeps.readFlowPushUrl(repoRoot);
  if (!read.ok) return { ok: false, result: failure(read.message) };
  if (pushRepositoryOf(read.url) !== state.remoteUrl) return { ok: false, result: failure(PUSH_TARGET_MOVED_MESSAGE) };
  return { ok: true, url: read.url };
}

/**
 * koda's relative flow link, joined onto the origin its web UI is served from.
 * A koda under a path prefix would need a configured web root; that is out of scope.
 */
export function flowLink(apiRoot: string, relative: string): string {
  const path = `/${relative.replace(/^\/+/, "")}`;
  try {
    return `${new URL(apiRoot).origin}${path}`;
  } catch {
    // A malformed API root has no origin to join onto; koda's own relative link is still usable.
    return path;
  }
}

/** The result of a created flow, or of an approval request holding the create. */
function outcomeContent(outcome: FlowCreateOutcome, connection: KodaFlowConnection): string {
  if (outcome.kind === "held") {
    return (
      `koda is holding the flow create for approval (request ${outcome.requestId}); no flow exists until it is ` +
      "approved, and pushing new commits to the branch before then makes koda refuse it."
    );
  }
  const link = flowLink(connection.url, outcome.url);
  return `${JSON.stringify({ flow: outcome.id, state: outcome.state, url: link })}\n${BILLING_NOTE}.`;
}

/** The `answered <status>: ` tail of a client error: koda's own message, without nax's prefix. */
function kodaMessageOf(message: string, status: number): string {
  const marker = `answered ${status}: `;
  const at = message.indexOf(marker);
  return at === -1 ? message : message.slice(at + marker.length);
}

/**
 * The message for an error code koda's contract classifies, or `undefined` for any other.
 *
 * A timeout or an unreachable host means no answer arrived, not that the create
 * did not happen: koda may have applied it before the response was lost or the
 * deadline expired. The message therefore says the outcome is unknown and sends
 * the user to koda before any retry, which would otherwise create a second flow.
 */
function classifiedKodaMessage(
  code: string | undefined,
  message: string,
  branch: string,
): ClassifiedKodaFailure | undefined {
  switch (code) {
    case "MEMORY_KODA_ABORTED":
      return { message: cancelledCreateMessage(branch), unknown: true };
    case "FLOW_KODA_UNEXPECTED_RESPONSE":
    case "MEMORY_KODA_BAD_RESPONSE":
      return { message: `[chat] koda answered unexpectedly: ${message}; branch ${branch} stays pushed`, unknown: true };
    case "MEMORY_KODA_TIMEOUT":
    case "MEMORY_KODA_UNREACHABLE":
      return {
        message:
          `[chat] koda could not be reached: ${message}; branch ${branch} stays pushed and the create's outcome is ` +
          "unknown — check koda for the flow before retrying, because a retry can create a duplicate",
        unknown: true,
      };
    default:
      return undefined;
  }
}

/**
 * The message for a create the turn cancelled.
 *
 * The push already happened, so the branch is on the remote; the request may have
 * been applied before the abort landed, so the outcome is unknown rather than
 * nothing. A retry would create a second flow, which koda refuses with a 409.
 */
function cancelledCreateMessage(branch: string): string {
  return (
    `[chat] the turn was cancelled during the koda request; branch ${branch} stays pushed and koda may have ` +
    "created the flow; check koda's flows before sending again (a duplicate send is refused with 409)"
  );
}

/**
 * The classified koda failure for the branch that stays pushed, or `undefined`
 * when the error is unclassified and the tool's own catch-all must report it.
 */
function kodaFailure(error: unknown, branch: string): ClassifiedKodaFailure | undefined {
  const message = errorMessage(error);
  const status = kodaStatusOf(error);
  if (status !== undefined) {
    return {
      message: `[chat] koda did not create the flow (HTTP ${status}): ${kodaMessageOf(message, status)}; branch ${branch} stays pushed`,
      // koda answered: it refused the create, so no flow exists for this branch.
      unknown: false,
    };
  }
  return classifiedKodaMessage(error instanceof NaxError ? error.code : undefined, message, branch);
}

/** Create the flow and report koda's answer; the branch is pushed by now, so every failure says so. */
async function createFlow(request: FlowAllowRequest, target: FlowSendTarget): Promise<PostAllowResult> {
  try {
    // An answer already received is the outcome: a later abort cannot replace it.
    const created = await _flowProviderDeps.createKodaFlow(target.connection, request.body, request.signal);
    return { result: { content: outcomeContent(created, target.connection) }, created };
  } catch (error) {
    const classified = kodaFailure(error, request.state.branch);
    // An unclassified failure is the tool's to report: its catch-all names it as a failed send.
    if (classified === undefined) throw error;
    return classified.unknown
      ? { result: failure(classified.message), unknown: true }
      : { result: failure(classified.message) };
  }
}

/** Verify Git and run the asynchronous guard; a cancellation takes precedence over a read error. */
async function verifyPush(request: FlowAllowRequest, repoRoot: string): Promise<PushDestination> {
  const { state, signal } = request;
  try {
    if (await branchMoved(state, repoRoot)) return { ok: false, result: failure(BRANCH_CHANGED_MESSAGE) };
    const moved = await pushTargetFailure(state, request.specPaths, repoRoot);
    if (moved !== undefined) return { ok: false, result: moved };
    const destination = await pushDestination(state, repoRoot);
    if (!destination.ok || turnCancelled(signal)) return destination;
    const guarded = await request.beforePush?.();
    return guarded === undefined ? destination : { ok: false, result: guarded };
  } catch (error) {
    if (!turnCancelled(signal)) throw error;
    return { ok: false, result: failure(CANCELLED_MESSAGE) };
  }
}

/**
 * Everything the allow buys: the re-check, the push, and the flow.
 *
 * The card described one commit, so the branch must still be on it — and the
 * tree must still be clean — before anything leaves the machine. The target the
 * push will resolve is verified separately, the destination the push is addressed
 * to is resolved and checked against the carded repository, and the push itself
 * names the carded commit (`sourceSha`) and that verified destination (`remote`):
 * `commitAndPush` binds that URL through a process-local alias that prevents a
 * second URL rewrite, and pushes `<sha>:refs/heads/<branch>`. Neither a commit
 * another process lands on the branch nor a remote or URL rewrite changed after
 * the check can decide what is pushed or where. A post-push branch-tip read
 * would not add anything to that — it cannot undo a push, and it would fail a
 * correct push whenever an unrelated commit lands afterwards.
 *
 * @param request - The carded state, the specs to re-check, the body and the turn's signal
 * @param target - The repository to push from and the koda server to create the flow in
 * @returns The result to report, and what koda answered when it answered
 */
export async function afterAllow(request: FlowAllowRequest, target: FlowSendTarget): Promise<PostAllowResult> {
  const { state, signal } = request;
  if (turnCancelled(signal)) return { result: failure(CANCELLED_MESSAGE) };
  const destination = await verifyPush(request, target.repoRoot);
  if (turnCancelled(signal)) return { result: failure(CANCELLED_MESSAGE) };
  if (!destination.ok) return { result: destination.result };
  const invalidAdmission = request.atPush?.();
  if (invalidAdmission !== undefined) return { result: invalidAdmission };
  try {
    await _flowProviderDeps.commitAndPush(target.repoRoot, state.branch, FLOW_PUSH_COMMIT_MESSAGE, {
      skipCommit: true,
      sourceSha: state.sha,
      remote: destination.url,
      signal,
    });
  } catch (error) {
    // An abort during the push kills git, so the failure is the cancel, not a push error.
    if (turnCancelled(signal)) return { result: failure(CANCELLED_MESSAGE) };
    throw error;
  }
  // The turn's signal goes on to the create: an Esc past the push must cancel the
  // request rather than let koda create a flow the transcript calls abandoned.
  return await createFlow(request, target);
}
