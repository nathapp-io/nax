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
import type { NaxConfig } from "@/config";
import { resolveRuleSet } from "@/context/rules/rule-set";
import { buildSubagentInstructions, toRulesIndexEntry } from "@/prompts";
import type { AgentResource } from "@/resources";
import { type ChatMode, chatSessionSettings } from "./chat-mode";

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
}

export const _subagentSessionDeps = {
  createAgentSession,
  nativeBackend,
  createMemoryTranscriptStore,
  resolveRuleSet,
};

/** Build every option before any session exists, so a failure here never opens one. */
async function subagentSessionOptions(
  input: RunSubagentInput,
  deps: typeof _subagentSessionDeps,
): Promise<CreateAgentSessionOptions> {
  const settings = chatSessionSettings(input.mode);
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

/** Run one task in a nested, memory-only native session and return the final turn's output. */
export async function runSubagent(input: RunSubagentInput, deps = _subagentSessionDeps): Promise<RunSubagentResult> {
  const options = await subagentSessionOptions(input, deps);
  const session = await deps.createAgentSession(options);
  try {
    input.onSession?.(session);
    let output = "";
    for await (const event of session.send(input.task)) {
      input.onEvent(event);
      if (event.type === "turn_end") output = event.output;
    }
    return { content: output };
  } finally {
    await session.close();
  }
}
