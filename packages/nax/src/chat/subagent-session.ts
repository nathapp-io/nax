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

/**
 * Run one task in a nested, memory-only native session and return the final turn's result.
 *
 * Turn failures and creation/send throws come back as an `isError` result; only a
 * failure to build the session options throws, before any session exists.
 */
export async function runSubagent(input: RunSubagentInput, deps = _subagentSessionDeps): Promise<RunSubagentResult> {
  if (input.signal?.aborted) return cancelledResult(input);
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
