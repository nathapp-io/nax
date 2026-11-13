/**
 * flow-provider.ts — the `nax-flow__send` tool and its card.
 *
 * One tool, one card, one outward push. `send` checks the request, koda's branch
 * rules and the repository before it asks the user; on allow it re-checks the
 * commit, pushes the branch and creates the flow in koda. Every failure is a
 * `[chat]` tool result — nothing throws out of the tool.
 *
 * The card is asked through the `approve` function the host supplies rather than
 * a mode-dependent wrapper: pushing a branch and creating a record in another
 * system is outward-facing, so the user is asked in every chat mode.
 *
 * Every collaborator is behind `_flowProviderDeps`, so a test drives each arm
 * without a repository, a remote or a koda server.
 */
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { commitAndPush, headSha } from "@/finish";
import { kodaStatusOf } from "@/memory";
import { buildFlowInstructions } from "@/prompts";
import type { HostApprovalCard } from "../ask-controller";
import type { KodaFlowConnection } from "./flow-connection";
import {
  FLOW_MAX_COST_CAP_USD,
  FLOW_MAX_FEATURES,
  type FlowSendFeature,
  type FlowSendInput,
  parseFlowSendInput,
} from "./flow-input";
import { createKodaFlow, type FlowCreateBody, type FlowCreateOutcome } from "./flow-koda";
import {
  checkFlowBranch,
  type FlowRepoReady,
  isFlowTreeDirty,
  normalizeGitHubRemote,
  readFlowPushUrl,
  readFlowRepoState,
} from "./flow-repo";

/** The provider id; the tool the brain sees is `nax-flow__send`. */
export const FLOW_PROVIDER_ID = "nax-flow";
/** The commit message `commitAndPush` takes; with `skipCommit` nothing is committed, so it is never used. */
export const FLOW_PUSH_COMMIT_MESSAGE = "chore: send flow to koda";

/** The qualified tool name, as the card names it. */
const TOOL_NAME = "nax-flow__send";
/** The card names the commit by its first characters; the push and the request carry it whole. */
const CARDED_SHA_CHARS = 8;
/** The one sentence both the card's last line and the created result's second line carry. */
const BILLING_NOTE = "koda will ask you to approve this flow before anything billed starts";
/** The declined result, matching the jobs tools' wording: a denial is final for that call. */
const DECLINED_MESSAGE =
  "[chat] the user declined sending the flow to koda; do not retry with different arguments unless the user asks";
/** Nothing was pushed: the commit the card described is no longer the one the branch is on. */
const BRANCH_CHANGED_MESSAGE = "[chat] the branch changed while the card was open; nothing was pushed";
/** HTTP(S) URLs, with any `user:token@` in front of the host removed so the repository can be read. */
const HTTPS_USERINFO_PREFIX = /^https?:\/\/[^/@]+@/i;

/** Nothing was pushed: the branch or the origin the push would resolve is no longer the one carded. */
const PUSH_TARGET_MOVED_MESSAGE =
  "[chat] the branch or origin being pushed changed while the card was open; nothing was pushed";
/** Nothing was pushed: the turn was cancelled between the card and the push. */
const CANCELLED_MESSAGE = "[chat] the turn was cancelled; nothing was pushed";
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

export interface FlowProviderOptions {
  /** The chat's repository root: what is pushed and what koda is told about. */
  readonly repoRoot: string;
  /** The koda API root and headers the flow is created through. */
  readonly connection: KodaFlowConnection;
  /** Puts the card in front of the user; the host's `requestHostApproval` in practice. */
  readonly approve: (card: HostApprovalCard) => Promise<"allow" | "deny">;
}

const FEATURE_DESCRIPTION =
  "One feature, in dependency order. `feature` matches ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ and is unique; " +
  "`specPath` is the repository-relative spec file, 1 to 300 characters, ending in .md, not starting with /, " +
  "with no NUL character and no .. segment; every `dependsOn` entry names a feature that appears earlier in " +
  "the list, never itself, once.";
const FEATURES_DESCRIPTION =
  `The features of the flow in dependency order, 1 to ${FLOW_MAX_FEATURES} of them. ` +
  "Send each specPath exactly as written; koda normalises it.";
const ROLES_DESCRIPTION =
  "The two model strings koda passes to its review steps (for example acp:codex), each matching " +
  "^[A-Za-z0-9._:/\\[\\]=,-]{1,200}$. They are model strings, not nax alias names: nax sends them as given.";
const COST_DESCRIPTION = `koda's billing ceiling for the flow in USD: a JSON number greater than 0 and at most ${FLOW_MAX_COST_CAP_USD}.`;

/** The `nax-flow__send` request, mirroring the checks `parseFlowSendInput` enforces at runtime. */
export const FLOW_SEND_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["features", "roles", "costCapUsd"],
  properties: {
    features: {
      type: "array",
      minItems: 1,
      maxItems: FLOW_MAX_FEATURES,
      description: FEATURES_DESCRIPTION,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["feature", "specPath"],
        description: FEATURE_DESCRIPTION,
        properties: {
          feature: {
            type: "string",
            description: "The feature's name: matches ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ and is unique in the list.",
          },
          specPath: {
            type: "string",
            description: "The spec file, repository-relative, sent exactly as the request wrote it.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "Features this one waits for; omit it for none.",
          },
        },
      },
    },
    roles: {
      type: "object",
      additionalProperties: false,
      required: ["reviewer", "supervisor"],
      description: ROLES_DESCRIPTION,
      properties: {
        reviewer: { type: "string", description: "The model string koda's spec review runs as." },
        supervisor: { type: "string", description: "The model string koda's supervisor runs as." },
      },
    },
    costCapUsd: { type: "number", exclusiveMinimum: 0, maximum: FLOW_MAX_COST_CAP_USD, description: COST_DESCRIPTION },
  },
} as const;

/**
 * The seam every collaborator of the run goes through: the repository read, the
 * push destination, the post-allow re-check, the push and the koda create. The
 * defaults are nax's own helpers, and `isDirty` defaults to the flow module's own
 * tree check so the pre-card and post-allow reads ask the same question —
 * untracked files count, because nothing here commits.
 */
export const _flowProviderDeps: {
  readFlowRepoState: typeof readFlowRepoState;
  readFlowPushUrl: typeof readFlowPushUrl;
  headSha: (repoRoot: string) => Promise<string | null>;
  isDirty: (repoRoot: string) => Promise<boolean>;
  commitAndPush: typeof commitAndPush;
  createKodaFlow: typeof createKodaFlow;
} = { readFlowRepoState, readFlowPushUrl, headSha, isDirty: isFlowTreeDirty, commitAndPush, createKodaFlow };

/** A failed run: one `[chat]` line, never a throw. */
function failure(content: string): ToolResult {
  return { isError: true, content };
}

/**
 * One carded value as the card shows it: control and format characters escaped, so
 * a value carrying a newline, a bidirectional override or an escape sequence — a
 * committed file name is the one that can — cannot forge an extra card line,
 * reorder the text around it or move the cursor while the user reads what they are
 * approving. The request body keeps the literal value.
 */
function cardText(value: string): string {
  return value.replace(CARD_ESCAPED_CHARS, (char) => {
    const code = char.charCodeAt(0).toString(16).padStart(UNICODE_ESCAPE_DIGITS, "0");
    return `\\u${code}`;
  });
}

/** The card's first line: the repository, the branch and the commit it was read at. */
function cardedRepoLine(state: FlowRepoReady): string {
  return `repo ${cardText(state.remoteUrl)} on branch ${cardText(state.branch)} at ${state.sha.slice(0, CARDED_SHA_CHARS)}`;
}

/** One feature line, with the dependencies it waits for when it has any. */
function featureLine(feature: FlowSendFeature, index: number): string {
  const line = `${index + 1}. ${cardText(feature.feature)} (${cardText(feature.specPath)})`;
  if (feature.dependsOn.length === 0) return line;
  return `${line} — after: ${feature.dependsOn.map(cardText).join(", ")}`;
}

/** What the user is agreeing to, in one string: repository, features, roles, cap and koda's own approval. */
function cardReason(state: FlowRepoReady, input: FlowSendInput): string {
  return [
    cardedRepoLine(state),
    ...input.features.map(featureLine),
    `reviewer ${cardText(input.roles.reviewer)}, supervisor ${cardText(input.roles.supervisor)}`,
    `cost cap $${input.costCapUsd.toFixed(2)}`,
    BILLING_NOTE,
  ].join("\n");
}

/** The one card a flow send shows, in every chat mode. */
function approvalCard(state: FlowRepoReady, input: FlowSendInput, signal?: AbortSignal): HostApprovalCard {
  return {
    tool: TOOL_NAME,
    summary: `send a flow of ${input.features.length} feature(s) to koda`,
    command: `git push --set-upstream origin ${state.branch}`,
    reason: cardReason(state, input),
    signal,
  };
}

/** A request that broke a rule: every error listed, nothing pushed. */
function inputFailure(errors: readonly string[]): ToolResult {
  return failure(`[chat] the flow request is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
}

/** The koda body: the repository as it was read, the features in order, the roles as given. */
function createBody(state: FlowRepoReady, input: FlowSendInput): FlowCreateBody {
  return {
    remoteUrl: state.remoteUrl,
    branch: state.branch,
    specSha: state.sha,
    features: input.features,
    roles: input.roles,
    costCapUsd: input.costCapUsd,
  };
}

/** Whether the branch no longer holds the commit the card described, or gained changes since. */
async function branchMoved(state: FlowRepoReady, repoRoot: string): Promise<boolean> {
  if ((await _flowProviderDeps.headSha(repoRoot)) !== state.sha) return true;
  return await _flowProviderDeps.isDirty(repoRoot);
}

/** The spec paths the request names: what the repository read resolves at the sent commit. */
function specPathsOf(input: FlowSendInput): readonly string[] {
  return input.features.map((feature) => feature.specPath);
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
 * @returns The `[chat]` result to stop with, or `undefined` when the target is still the carded one
 */
async function pushTargetFailure(
  state: FlowRepoReady,
  input: FlowSendInput,
  repoRoot: string,
): Promise<ToolResult | undefined> {
  const now = await _flowProviderDeps.readFlowRepoState(repoRoot, specPathsOf(input));
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
function flowLink(apiRoot: string, relative: string): string {
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
function classifiedKodaMessage(code: string | undefined, message: string, branch: string): string | undefined {
  switch (code) {
    case "FLOW_KODA_UNEXPECTED_RESPONSE":
    case "MEMORY_KODA_BAD_RESPONSE":
      return `[chat] koda answered unexpectedly: ${message}; branch ${branch} stays pushed`;
    case "MEMORY_KODA_TIMEOUT":
    case "MEMORY_KODA_UNREACHABLE":
      return (
        `[chat] koda could not be reached: ${message}; branch ${branch} stays pushed and the create's outcome is ` +
        "unknown — check koda for the flow before retrying, because a retry can create a duplicate"
      );
    default:
      return undefined;
  }
}

/**
 * The classified koda failure for the branch that stays pushed, or `undefined`
 * when the error is unclassified and the tool's own catch-all must report it.
 */
function kodaFailure(error: unknown, branch: string): string | undefined {
  const message = errorMessage(error);
  const status = kodaStatusOf(error);
  if (status !== undefined) {
    return `[chat] koda did not create the flow (HTTP ${status}): ${kodaMessageOf(message, status)}; branch ${branch} stays pushed`;
  }
  return classifiedKodaMessage(error instanceof NaxError ? error.code : undefined, message, branch);
}

/** Create the flow and report koda's answer; the branch is pushed by now, so every failure says so. */
async function createFlow(
  state: FlowRepoReady,
  input: FlowSendInput,
  options: FlowProviderOptions,
): Promise<ToolResult> {
  try {
    const outcome = await _flowProviderDeps.createKodaFlow(options.connection, createBody(state, input));
    return { content: outcomeContent(outcome, options.connection) };
  } catch (error) {
    const classified = kodaFailure(error, state.branch);
    // An unclassified failure is the tool's to report: its catch-all names it as a failed send.
    if (classified === undefined) throw error;
    return failure(classified);
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
 * `commitAndPush` then runs
 * `git push --set-upstream <verified push URL> <sha>:refs/heads/<branch>`, so
 * neither a commit another process lands on the branch nor a remote repointed
 * after the check can decide what is pushed or where. A post-push branch-tip read
 * would not add anything to that — it cannot undo a push, and it would fail a
 * correct push whenever an unrelated commit lands afterwards.
 */
async function afterAllow(
  state: FlowRepoReady,
  input: FlowSendInput,
  options: FlowProviderOptions,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted === true) return failure(CANCELLED_MESSAGE);
  if (await branchMoved(state, options.repoRoot)) return failure(BRANCH_CHANGED_MESSAGE);
  const target = await pushTargetFailure(state, input, options.repoRoot);
  if (target !== undefined) return target;
  const destination = await pushDestination(state, options.repoRoot);
  if (!destination.ok) return destination.result;
  await _flowProviderDeps.commitAndPush(options.repoRoot, state.branch, FLOW_PUSH_COMMIT_MESSAGE, {
    skipCommit: true,
    sourceSha: state.sha,
    remote: destination.url,
  });
  return await createFlow(state, input, options);
}

/**
 * Check the request, koda's branch rules and the repository, then ask the user.
 *
 * @param request - The tool input as the model produced it
 * @param signal - The turn's cancellation, which the card is closed by
 * @param options - The repository, the koda connection and the approval ask
 */
async function send(
  request: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: FlowProviderOptions,
): Promise<ToolResult> {
  const parsed = parseFlowSendInput(request);
  if ("errors" in parsed) return inputFailure(parsed.errors);
  const state = await _flowProviderDeps.readFlowRepoState(options.repoRoot, specPathsOf(parsed));
  if (!state.ok) return failure(state.message);
  const branch = checkFlowBranch(state.branch, parsed.features);
  if (branch !== undefined) return failure(branch);
  const decision = await options.approve(approvalCard(state, parsed, signal));
  if (decision === "deny") return failure(DECLINED_MESSAGE);
  return await afterAllow(state, parsed, options, signal);
}

function sendTool(options: FlowProviderOptions): ProviderTool {
  return {
    localName: "send",
    description:
      "Hand a settled set of feature specs to koda as a flow: asks the user for explicit approval, then pushes " +
      "the current branch and creates the flow in koda.",
    inputSchema: FLOW_SEND_INPUT_SCHEMA,
    // No failure leaves the tool: an unclassified rejection — a git error, a rejecting
    // `approve` — is reported the way every other failure is, as a `[chat]` result.
    run: async (input, ctx) => {
      try {
        return await send(input, ctx.signal, options);
      } catch (error) {
        return failure(`[chat] flow send failed: ${errorMessage(error)}`);
      }
    },
  };
}

/** The `nax-flow` provider: offered to the chat brain only, and only with a koda connection. */
export function createFlowProvider(options: FlowProviderOptions): ToolProvider {
  return {
    id: FLOW_PROVIDER_ID,
    kind: "static",
    stages: ["*"],
    instructions: async () => buildFlowInstructions(),
    tools: async () => [sendTool(options)],
  };
}
