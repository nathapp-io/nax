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
import { checkFlowBranch, type FlowRepoReady, isFlowTreeDirty, readFlowRepoState } from "./flow-repo";

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
/** Nothing was pushed: the turn was cancelled between the card and the push. */
const CANCELLED_MESSAGE = "[chat] the turn was cancelled; nothing was pushed";

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
 * post-allow re-check, the push and the koda create. The defaults are nax's own
 * helpers, and `isDirty` defaults to the flow module's own tree check so the
 * pre-card and post-allow reads ask the same question — untracked files count,
 * because nothing here commits.
 */
export const _flowProviderDeps: {
  readFlowRepoState: typeof readFlowRepoState;
  headSha: (repoRoot: string) => Promise<string | null>;
  isDirty: (repoRoot: string) => Promise<boolean>;
  commitAndPush: typeof commitAndPush;
  createKodaFlow: typeof createKodaFlow;
} = { readFlowRepoState, headSha, isDirty: isFlowTreeDirty, commitAndPush, createKodaFlow };

/** A failed run: one `[chat]` line, never a throw. */
function failure(content: string): ToolResult {
  return { isError: true, content };
}

/** The card's first line: the repository, the branch and the commit it was read at. */
function cardedRepoLine(state: FlowRepoReady): string {
  return `repo ${state.remoteUrl} on branch ${state.branch} at ${state.sha.slice(0, CARDED_SHA_CHARS)}`;
}

/** One feature line, with the dependencies it waits for when it has any. */
function featureLine(feature: FlowSendFeature, index: number): string {
  const line = `${index + 1}. ${feature.feature} (${feature.specPath})`;
  return feature.dependsOn.length === 0 ? line : `${line} — after: ${feature.dependsOn.join(", ")}`;
}

/** What the user is agreeing to, in one string: repository, features, roles, cap and koda's own approval. */
function cardReason(state: FlowRepoReady, input: FlowSendInput): string {
  return [
    cardedRepoLine(state),
    ...input.features.map(featureLine),
    `reviewer ${input.roles.reviewer}, supervisor ${input.roles.supervisor}`,
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

/** The message for an error code koda's contract classifies, or `undefined` for any other. */
function classifiedKodaMessage(code: string | undefined, message: string, branch: string): string | undefined {
  switch (code) {
    case "FLOW_KODA_UNEXPECTED_RESPONSE":
    case "MEMORY_KODA_BAD_RESPONSE":
      return `[chat] koda answered unexpectedly: ${message}; branch ${branch} stays pushed`;
    case "MEMORY_KODA_TIMEOUT":
    case "MEMORY_KODA_UNREACHABLE":
      return `[chat] koda could not be reached: ${message}; branch ${branch} stays pushed and no flow was created`;
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
 * tree must still be clean — before anything leaves the machine.
 */
async function afterAllow(
  state: FlowRepoReady,
  input: FlowSendInput,
  options: FlowProviderOptions,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted === true) return failure(CANCELLED_MESSAGE);
  if (await branchMoved(state, options.repoRoot)) return failure(BRANCH_CHANGED_MESSAGE);
  await _flowProviderDeps.commitAndPush(options.repoRoot, state.branch, FLOW_PUSH_COMMIT_MESSAGE, {
    skipCommit: true,
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
  const state = await _flowProviderDeps.readFlowRepoState(
    options.repoRoot,
    parsed.features.map((f) => f.specPath),
  );
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
