import {
  type AgentSession,
  type CreateAgentSessionOptions,
  createAgentSession,
  createMemoryTranscriptStore,
  type LoopHandlerSet,
  nativeBackend,
  type SessionEvent,
  type ToolProvider,
} from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type NaxConfig, resolveTuiPermissions, type TuiPermissions } from "@/config";
import { resolveRuleSet } from "@/context/rules/rule-set";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import { buildSubagentInstructions, toRulesIndexEntry } from "@/prompts";
import type { AgentResource } from "@/resources";
import {
  type AcpSubagentProfile,
  acpAgentLabel,
  acpReadOnlyEnforced,
  acpSubagentProfile,
  acpSubagentSessionOptions,
  type ChatAcpModel,
  isReadOnlyAcpProfile,
  parseChatAcpModel,
} from "./acp";
import { type ChatMode, chatBackendPosture, chatSessionSettings } from "./chat-mode";

export interface RunSubagentInput {
  readonly agent: AgentResource;
  readonly task: string;
  /** The chat session's mode at call time. */
  readonly mode: ChatMode;
  /** From resolveSubagentModel. */
  readonly model: string;
  /** From mapSubagentTools; absent means no narrowing, `[]` means no tools beyond the always-on ones. */
  readonly allowedTools?: readonly string[];
  /** The chat resources' providers, never the agents provider. */
  readonly toolProviders: readonly ToolProvider[];
  /** The chat host's handler set. */
  readonly loopHandlers: LoopHandlerSet;
  readonly cwd: string;
  readonly repoRoot: string;
  readonly config: NaxConfig;
  readonly parentSessionId: string;
  /** The parent session's rendered memory index; the nested session's instructions carry it. */
  readonly memoryIndex?: string;
  readonly signal?: AbortSignal;
  readonly onEvent: (event: SessionEvent) => void;
  /** Called with the nested session once it is created, before its turn starts. */
  readonly onSession?: (session: AgentSession) => void;
}

export interface RunSubagentResult {
  readonly content: string;
  /** Present and true when the nested turn did not complete or the run failed. */
  readonly isError?: true;
}

export const _subagentSessionDeps = {
  createAgentSession,
  nativeBackend,
  createMemoryTranscriptStore,
  resolveRuleSet,
  resolveTuiPermissions,
};

/** Build every option before any session exists, so a failure here never opens one. */
async function subagentSessionOptions(
  input: RunSubagentInput,
  posture: TuiPermissions | undefined,
  deps: typeof _subagentSessionDeps,
): Promise<CreateAgentSessionOptions> {
  const settings = chatSessionSettings(input.mode, posture);
  const rules = input.config.context.rules;
  const set = await deps.resolveRuleSet({
    repoRoot: input.repoRoot,
    packageDir: input.repoRoot,
    overrideDir: rules?.overrideDir,
    overrideMode: rules?.overrideMode,
  });
  const catalogOverrides = input.config.agent?.native?.catalogOverrides;
  const compaction = input.config.execution.compaction;
  return {
    backend: deps.nativeBackend({
      ...chatBackendPosture(input.mode, input.config, posture),
      model: input.model,
      bashApproval: settings.bashApproval,
      allowUnsandboxed: true,
      allowUnsandboxedCommands: true,
      carryHistoryAcrossModels: true,
      loopHandlers: input.loopHandlers,
      loopHandlerRole: "subagent",
      toolProviders: input.toolProviders,
      ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(catalogOverrides?.length ? { catalogOverrides } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
    }),
    profile: settings.profile,
    workdir: input.cwd,
    transcriptStore: deps.createMemoryTranscriptStore(),
    metadata: { parentSessionId: input.parentSessionId, subagent: input.agent.qualifiedName },
    approvalTimeoutMs: input.config.execution.approvalTimeout,
    instructions: buildSubagentInstructions({
      agent: input.agent,
      mode: input.mode,
      rulesIndex: set.rules.map(toRulesIndexEntry),
      ...(input.memoryIndex !== undefined ? { memoryIndex: input.memoryIndex } : {}),
    }),
  };
}

const NO_TEXT_CONTENT = "(the subagent returned no text)";

type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;

function cancelledResult(input: RunSubagentInput): RunSubagentResult {
  return { isError: true, content: `subagent ${input.agent.qualifiedName} cancelled: cancelled` };
}

function failedResult(input: RunSubagentInput, err: unknown): RunSubagentResult {
  return { isError: true, content: `[chat] subagent ${input.agent.qualifiedName} failed: ${errorMessage(err)}` };
}

/** Map the nested turn's terminal event to the tool result the parent model sees. */
function resultOfTurn(input: RunSubagentInput, end: TurnEndEvent): RunSubagentResult {
  if (end.status === "completed") return { content: end.output === "" ? NO_TEXT_CONTENT : end.output };
  const detail = end.error?.message ?? end.status;
  return { isError: true, content: `subagent ${input.agent.qualifiedName} ${end.status}: ${detail}` };
}

/** Drive one turn, passing every event on in order; the final text comes from `turn_end`. */
async function driveTurn(session: AgentSession, input: RunSubagentInput): Promise<RunSubagentResult> {
  let end: TurnEndEvent | undefined;
  for await (const event of session.send(input.task)) {
    input.onEvent(event);
    if (event.type === "turn_end") end = event;
  }
  if (end === undefined) {
    throw new NaxError("the nested turn ended without a turn_end event", "CHAT_SUBAGENT_NO_TURN_END", {
      stage: "chat",
      subagent: input.agent.qualifiedName,
    });
  }
  return resultOfTurn(input, end);
}

/** Close the session; a failing close is logged and never replaces the turn's result. */
async function closeQuietly(session: AgentSession, input: RunSubagentInput): Promise<void> {
  try {
    await session.close();
  } catch (err) {
    getLogger().warn("chat", "subagent session close failed", {
      subagent: input.agent.qualifiedName,
      parentSessionId: input.parentSessionId,
      error: errorMessage(err),
    });
  }
}

async function runOnSession(session: AgentSession, input: RunSubagentInput): Promise<RunSubagentResult> {
  const { signal } = input;
  const onAbort = () => session.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) return cancelledResult(input);
    input.onSession?.(session);
    return await driveTurn(session, input);
  } catch (err) {
    return failedResult(input, err);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await closeQuietly(session, input);
  }
}

/** The profile a subagent's own `tools:` list, the chat's mode and the operator's override derive. */
function subagentProfile(input: RunSubagentInput): AcpSubagentProfile {
  return acpSubagentProfile({
    tools: input.agent.tools,
    mode: input.mode,
    ...(input.config.agent?.acpSubagents?.profile !== undefined
      ? { override: input.config.agent.acpSubagents.profile }
      : {}),
  });
}

/** A read-only subagent whose agent enforces nothing would be told it cannot write and could. */
function readOnlyRefusal(
  input: RunSubagentInput,
  acp: ChatAcpModel,
  profile: AcpSubagentProfile,
): RunSubagentResult | undefined {
  if (!isReadOnlyAcpProfile(profile) || acpReadOnlyEnforced(acp.agent)) return undefined;
  return {
    isError: true,
    content: `[chat] subagent ${input.agent.qualifiedName} could not start read-only: ${acpAgentLabel(acp.agent)} has no read-only enforcement of its own`,
  };
}

/**
 * Run the nested session on the ACP agent the model names.
 *
 * A refusing profile opens nothing; an option-build or creation throw is the
 * subagent's failure, so it comes back as a result rather than a rejection.
 */
async function runAcpSubagent(
  input: RunSubagentInput,
  acp: ChatAcpModel,
  deps: typeof _subagentSessionDeps,
): Promise<RunSubagentResult> {
  const profile = subagentProfile(input);
  const refusal = readOnlyRefusal(input, acp, profile);
  if (refusal !== undefined) return refusal;
  let session: AgentSession;
  try {
    const options = await acpSubagentSessionOptions({ ...input, acp, profile }, () =>
      deps.createMemoryTranscriptStore(),
    );
    session = await deps.createAgentSession(options);
  } catch (err) {
    return failedResult(input, err);
  }
  return runOnSession(session, input);
}

/**
 * Run one task in a nested, memory-only session and return the final turn's result.
 *
 * The model picks the transport. A native `<provider>/<model>` string runs the
 * session nax itself backs; an `acp:` string runs an ephemeral session of the agent
 * it names, in the profile its `tools:` list and the chat's mode derive. Both go
 * through the same lifecycle — announce, one turn, forward events, close — and a
 * turn failure, a creation throw or an ACP option-build throw comes back as an
 * `isError` result, so the parent turn continues either way.
 *
 * Only native option construction still throws, before any session exists: its
 * configuration errors are the caller's to surface, not the subagent's to report.
 */
export async function runSubagent(input: RunSubagentInput, deps = _subagentSessionDeps): Promise<RunSubagentResult> {
  if (input.signal?.aborted) return cancelledResult(input);
  let acp: ChatAcpModel | undefined;
  try {
    acp = parseChatAcpModel(input.model);
  } catch (err) {
    return failedResult(input, err);
  }
  if (acp !== undefined) return runAcpSubagent(input, acp, deps);
  const posture = input.mode === "guarded" ? deps.resolveTuiPermissions(input.config) : undefined;
  const options = await subagentSessionOptions(input, posture, deps);
  let session: AgentSession;
  try {
    session = await deps.createAgentSession(options);
  } catch (err) {
    return failedResult(input, err);
  }
  return runOnSession(session, input);
}
