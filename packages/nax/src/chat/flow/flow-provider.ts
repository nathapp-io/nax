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
 * The request has two forms: the spec form here, and the handoff form the run routes
 * to `flow-handoff.ts` before any parse. Everything either form does after its card
 * lives in `flow-send-steps.ts`.
 *
 * Every collaborator is behind `_flowProviderDeps`, so a test drives each arm
 * without a repository, a remote or a koda server.
 */
import type { ProviderTool, ToolProvider, ToolResult } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { buildFlowInstructions } from "@/prompts";
import type { HostApprovalCard } from "../ask-controller";
import { _flowProviderDeps } from "./flow-deps";
import { sendFlowHandoff } from "./flow-handoff";
import {
  FLOW_COST_CAP_DECIMALS,
  FLOW_MAX_COST_CAP_USD,
  FLOW_MAX_FEATURES,
  type FlowSendFeature,
  type FlowSendInput,
  parseFlowSendInput,
} from "./flow-input";
import type { FlowCreateBody } from "./flow-koda";
import { checkFlowBranch, type FlowRepoReady } from "./flow-repo";
import {
  afterAllow,
  BILLING_NOTE,
  cardedRepoLine,
  cardText,
  DECLINED_MESSAGE,
  type FlowProviderOptions,
  failure,
  inputFailure,
  TOOL_NAME,
} from "./flow-send-steps";

/** The provider id; the tool the brain sees is `nax-flow__send`. */
export const FLOW_PROVIDER_ID = "nax-flow";
/**
 * How long `nax-flow__send` may keep working after the turn is cancelled, so its own
 * outcome — nothing was pushed, or the branch is pushed and koda may have the flow —
 * reaches the transcript instead of the generic abandoned message. The create has a
 * 30 s deadline of its own, so this bounds only the answer's journey back.
 */
export const FLOW_SEND_CANCEL_GRACE_MS = 5_000;

export { _flowProviderDeps } from "./flow-deps";
export { FLOW_PUSH_COMMIT_MESSAGE } from "./flow-send-steps";
export type { FlowProviderOptions };

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
const HANDOFF_DESCRIPTION =
  "One feature this chat already ran, handed to koda to publish and finish it. Send either `handoff` or " +
  "`features`, never both and never neither: the handoff form carries no spec paths, because the feature's specs " +
  'are already on the branch. Its workflow run must have ended without a PR (publish "none").';
const COST_DESCRIPTION =
  `koda's billing ceiling for the flow in USD: a JSON number (not a numeric string) greater than 0 and at most ` +
  `${FLOW_MAX_COST_CAP_USD}. koda compares the number's string form, so its decimal form carries at most ` +
  `${FLOW_COST_CAP_DECIMALS} decimal places — 5 and 5.25 pass, 1.23456 does not.`;

/** The `nax-flow__send` request, mirroring the checks `parseFlowSendInput` enforces at runtime. */
export const FLOW_SEND_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  // `features` is not required: the handoff form sends one `feature` name instead, and
  // the runtime parser refuses a body carrying both forms or neither.
  required: ["roles", "costCapUsd"],
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
    handoff: {
      type: "object",
      additionalProperties: false,
      required: ["feature"],
      description: HANDOFF_DESCRIPTION,
      properties: {
        feature: {
          type: "string",
          description: "The feature's name: matches ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$, with a finished workflow run.",
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

/** The one card a spec-form flow send shows, in every chat mode. */
function approvalCard(state: FlowRepoReady, input: FlowSendInput, signal?: AbortSignal): HostApprovalCard {
  return {
    tool: TOOL_NAME,
    summary: `send a flow of ${input.features.length} feature(s) to koda`,
    command: `git push --set-upstream origin ${state.branch}`,
    reason: cardReason(state, input),
    signal,
  };
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

/** The spec paths the request names: what the repository read resolves at the sent commit. */
function specPathsOf(input: FlowSendInput): readonly string[] {
  return input.features.map((feature) => feature.specPath);
}

/**
 * Whether the request is the handoff form: `handoff` and no `features`.
 *
 * Read before any parse, so a handoff body never reaches the spec form's parser —
 * which would refuse it for carrying neither `features` nor a spec path.
 */
function isHandoffRequest(request: Record<string, unknown>): boolean {
  return Object.hasOwn(request, "handoff") && !Object.hasOwn(request, "features");
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
  const allow = { state, specPaths: specPathsOf(parsed), body: createBody(state, parsed), signal };
  return (await afterAllow(allow, options)).result;
}

function sendTool(options: FlowProviderOptions): ProviderTool {
  return {
    localName: "send",
    description:
      "Hand a settled set of feature specs to koda as a flow: asks the user for explicit approval, then pushes " +
      "the current branch and creates the flow in koda.",
    inputSchema: FLOW_SEND_INPUT_SCHEMA,
    // The push and the create both settle their own outcome after an Esc, so the
    // transcript gets "nothing was pushed" or "the branch is pushed, check koda"
    // rather than the generic abandoned message.
    cancelGraceMs: FLOW_SEND_CANCEL_GRACE_MS,
    // No failure leaves the tool: an unclassified rejection — a git error, a rejecting
    // `approve` — is reported the way every other failure is, as a `[chat]` result.
    run: async (input, ctx) => {
      try {
        const route = isHandoffRequest(input) ? sendFlowHandoff : send;
        return await route(input, ctx.signal, options);
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
