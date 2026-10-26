/**
 * Host-level harness for the chat subagents (chat-subagents US-009/US-010).
 *
 * `createChatHost` runs with no `open` override, so the real opener builds the chat
 * session: `_openChatSessionDeps.createAgentSession` returns a scripted chat session and
 * `_openChatSessionDeps.nativeBackend` captures its options. The scripted session's `send`
 * finds the `nax-agents` provider in the captured providers and runs the `run` tool the way
 * the model would, with the turn's `AbortSignal` on the tool context. The nested session is
 * driven through `_subagentSessionDeps`. Call `dispose()` after each test to restore every seam.
 */

import { join } from "node:path";
import {
  type AgentSession,
  type AnswerReply,
  type CreateAgentSessionOptions,
  createMemoryTranscriptStore,
  createSessionStorage,
  type SessionBackend,
  type SessionEvent,
  type SessionStorage,
  type ToolProvider,
  type ToolResult,
  type ToolRunContext,
} from "@nathapp/nax-agent";
import { type ChatHost, type ChatResources, createChatHost } from "@/chat";
import { _openChatSessionDeps } from "@/chat/open-chat-session";
import { _subagentSessionDeps } from "@/chat/subagent-session";
import type { NaxConfig } from "@/config";
import { type AgentResource, buildResourceCatalog, type ResourceCatalog } from "@/resources";
import { makeLogger } from "./mock-logger";
import { makeNaxConfig } from "./mock-nax-config";
import { cleanupTempDir, makeTempDir } from "./temp";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const AT = NOW.toISOString();
const EVENT_BASE = { sessionId: "scripted", turnId: "t", at: AT, metadata: {} };

export const CHAT_MODEL = "anthropic/chat-model";

type OpenBackendOptions = Parameters<typeof _openChatSessionDeps.nativeBackend>[0];
type NestedBackendOptions = Parameters<typeof _subagentSessionDeps.nativeBackend>[0];
type ApprovalRequested = Extract<SessionEvent, { type: "approval_requested" }>;

export type AnswerRecord = readonly [requestId: string, reply: AnswerReply];

/** An `AgentSession` that records its `answer`, `cancel` and `close` calls. */
export interface ScriptedSession extends AgentSession {
  readonly answers: AnswerRecord[];
  cancelCalls: number;
  closeCalls: number;
}

export function makeAgentResource(overrides: Partial<AgentResource> = {}): AgentResource {
  const name = overrides.name ?? "reviewer";
  return {
    kind: "agent",
    name,
    qualifiedName: name,
    description: "Reviews diffs",
    prompt: "Review the diff.",
    path: `/repo/.claude/agents/${name}.md`,
    origin: { kind: "claude-project" },
    ...overrides,
  };
}

/** A catalog holding exactly the given agents, built through the real catalog builder. */
export function makeAgentCatalog(agents: readonly AgentResource[]): ResourceCatalog {
  return buildResourceCatalog([
    {
      id: "claude-project",
      origin: { kind: "claude-project" },
      root: "/repo",
      skills: [],
      commands: [],
      agents,
      mcpServers: [],
      hooks: [],
      diagnostics: [],
    },
  ]);
}

export function turnEndEvent(output = "done", costUsd = 0): SessionEvent {
  return {
    ...EVENT_BASE,
    type: "turn_end",
    status: "completed",
    output,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd,
  };
}

export function turnStartEvent(at: string = AT): SessionEvent {
  return { ...EVENT_BASE, at, type: "turn_start" };
}

export function usageEvent(at: string = AT, costUsd = 0.1): SessionEvent {
  return {
    ...EVENT_BASE,
    at,
    type: "usage",
    round: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd,
    costSource: "computed",
  };
}

export function toolCallEvent(callId = "c1"): SessionEvent {
  return { ...EVENT_BASE, type: "tool_call", callId, name: "Read", input: { path: "a.ts" } };
}

export function toolResultEvent(callId = "c1"): SessionEvent {
  return { ...EVENT_BASE, type: "tool_result", callId, isError: false, preview: "contents" };
}

export function textDeltaEvent(text = "hello"): SessionEvent {
  return { ...EVENT_BASE, type: "text_delta", round: 1, text };
}

export function approvalRequestedEvent(
  requestId: string,
  reason: string,
  overrides: Partial<ApprovalRequested> = {},
): SessionEvent {
  return {
    ...EVENT_BASE,
    type: "approval_requested",
    requestId,
    tool: "Write",
    command: "a.ts",
    summary: "write a.ts",
    reason,
    expiresAt: AT,
    ...overrides,
  };
}

export function questionEvent(requestId: string, text: string): SessionEvent {
  return { ...EVENT_BASE, type: "question", requestId, text, expiresAt: AT };
}

export function approvalResolvedEvent(requestId: string): SessionEvent {
  return { ...EVENT_BASE, type: "approval_resolved", requestId, decision: "allow", decidedBy: "human" };
}

/** A session whose `send` runs `script`; its `answer`/`cancel`/`close` calls are recorded. */
export function makeScriptedSession(
  id: string,
  script: () => AsyncIterable<SessionEvent>,
  hooks: { onCancel?: () => void; closeGate?: Promise<void> } = {},
): ScriptedSession {
  const session: ScriptedSession = {
    id,
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    answers: [],
    cancelCalls: 0,
    closeCalls: 0,
    send: () => script(),
    answer(requestId, reply) {
      session.answers.push([requestId, reply]);
      return "accepted";
    },
    cancel() {
      session.cancelCalls++;
      hooks.onCancel?.();
    },
    async close() {
      session.closeCalls++;
      await hooks.closeGate;
    },
  };
  return session;
}

export interface SubagentHostOptions {
  readonly agents?: readonly AgentResource[];
  readonly modelAliases?: Record<string, string>;
  /** The agent the scripted chat session runs; defaults to the first agent. */
  readonly runAgent?: string;
  /** Events the nested session emits before it ends its turn. */
  readonly nestedEvents?: readonly SessionEvent[];
  /** Keep the nested turn open until `releaseNested()` or the nested session is cancelled. */
  readonly holdNested?: boolean;
  /** Do not run the agent from the scripted chat session's send. */
  readonly skipRun?: boolean;
  /** `costUsd` of the nested turn's `turn_end`; defaults to 0. */
  readonly nestedCostUsd?: number;
  /** Status of the nested turn's `turn_end`; defaults to completed. */
  readonly nestedStatus?: "completed" | "cancelled";
  /** `costUsd` of the chat turn's `turn_end`; defaults to 0. */
  readonly chatCostUsd?: number;
  /** The chat session's send throws after the nested run settled. */
  readonly chatThrows?: boolean;
  /** Keep the chat turn open, after its nested run settled, until `releaseChat()`. */
  readonly holdChat?: boolean;
  /** Events the nested session emits after its held turn is released, before `turn_end`. */
  readonly nestedLateEvents?: readonly SessionEvent[];
  /** Keep every nested session's `close()` pending until `releaseNestedClose()`. */
  readonly holdNestedClose?: boolean;
  /**
   * Like the real interaction handler: the chat turn stops waiting for the `run` tool when
   * the turn's signal aborts and abandons the pending call.
   */
  readonly abandonToolOnAbort?: boolean;
  /** A cancelled nested turn keeps running until `releaseNested()` instead of ending at once. */
  readonly holdNestedPastCancel?: boolean;
}

/** Per-send script switches; a test may change them between sends. */
export interface SubagentHostControl {
  skipRun: boolean;
  nestedCostUsd: number;
  chatCostUsd: number;
  chatThrows: boolean;
}

export interface SubagentHostHarness {
  readonly host: ChatHost;
  readonly config: NaxConfig;
  readonly resources: ChatResources;
  readonly storage: SessionStorage;
  readonly chatSessions: ScriptedSession[];
  /** Options of every chat-session backend the real opener built, in order. */
  readonly chatBackends: OpenBackendOptions[];
  readonly nestedSessions: ScriptedSession[];
  readonly nestedSessionOptions: CreateAgentSessionOptions[];
  readonly nestedBackends: NestedBackendOptions[];
  /** Results of the scripted chat session's `run` tool calls. */
  readonly toolResults: ToolResult[];
  /** The signal the scripted session put on the tool's run context for its latest turn. */
  turnSignal(): AbortSignal | undefined;
  abortTurn(): void;
  releaseNested(): void;
  releaseNestedClose(): void;
  releaseChat(): void;
  readonly control: SubagentHostControl;
  /** Persist metadata so `resume({ id })` finds a session. */
  storeSession(id: string, mode?: "ask" | "full"): Promise<void>;
  /** The `nax-agents` provider of the latest chat backend. */
  agentsProvider(): ToolProvider | undefined;
  dispose(): Promise<void>;
}

export function makeSubagentHostHarness(options: SubagentHostOptions = {}): SubagentHostHarness {
  const dir = makeTempDir("chat-subagents-");
  const originalOpen = { ..._openChatSessionDeps };
  const originalNested = { ..._subagentSessionDeps };
  const config = makeNaxConfig({
    outputDir: join(dir, "output"),
    ...(options.modelAliases ? { agent: { modelAliases: options.modelAliases } } : {}),
  });
  const storage = createSessionStorage({
    dir: join(dir, "sessions"),
    pid: process.pid,
    now: () => NOW,
    logger: makeLogger(),
    isAlive: () => true,
  });
  const agents = options.agents ?? [];
  const resources: ChatResources = {
    catalog: makeAgentCatalog(agents),
    toolProviders: [{ id: "base", kind: "static", stages: ["*"], tools: async () => [] }],
    pluginHandlers: [],
    naxPlugins: [],
    teardown: async () => {},
  };

  const chatSessions: ScriptedSession[] = [];
  const chatBackends: OpenBackendOptions[] = [];
  const nestedSessions: ScriptedSession[] = [];
  const nestedSessionOptions: CreateAgentSessionOptions[] = [];
  const nestedBackends: NestedBackendOptions[] = [];
  const toolResults: ToolResult[] = [];
  const released = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const closeGate = Promise.withResolvers<void>();
  const chatGate = Promise.withResolvers<void>();
  const control: SubagentHostControl = {
    skipRun: options.skipRun ?? false,
    nestedCostUsd: options.nestedCostUsd ?? 0,
    chatCostUsd: options.chatCostUsd ?? 0,
    chatThrows: options.chatThrows ?? false,
  };
  let turn: AbortController | undefined;
  let counter = 0;
  const runAgentName = options.runAgent ?? agents[0]?.name ?? "reviewer";
  const backend: SessionBackend = {
    kind: "native",
    async open() {
      throw new Error("unused");
    },
  };
  const agentsProvider = () => chatBackends.at(-1)?.toolProviders?.find((provider) => provider.id === "nax-agents");

  let chatTurnActive = false;
  async function* chatTurn(): AsyncGenerator<SessionEvent> {
    // Like the real session: a second concurrent send is rejected.
    if (chatTurnActive) throw new Error("turn already running");
    chatTurnActive = true;
    try {
      yield* chatTurnBody();
    } finally {
      chatTurnActive = false;
    }
  }

  async function* chatTurnBody(): AsyncGenerator<SessionEvent> {
    const tool = control.skipRun
      ? undefined
      : (await agentsProvider()?.tools("/repo"))?.find((t) => t.localName === "run");
    if (tool) {
      turn = new AbortController();
      const ctx: ToolRunContext = {
        root: "/repo",
        resolvedPaths: [],
        maxBytes: 1_000_000,
        maxFileBytes: 1_000_000,
        signal: turn.signal,
      };
      const pendingRun = tool.run({ agent: runAgentName, task: "check it" }, ctx);
      toolResults.push(
        options.abandonToolOnAbort
          ? await Promise.race([
              pendingRun,
              new Promise<ToolResult>((resolve) =>
                turn?.signal.addEventListener("abort", () => resolve({ isError: true, content: "abandoned" }), {
                  once: true,
                }),
              ),
            ])
          : await pendingRun,
      );
    }
    if (options.holdChat) await chatGate.promise;
    if (control.chatThrows) throw new Error("chat send failed");
    yield turnEndEvent("chat done", control.chatCostUsd);
  }

  async function* nestedTurn(): AsyncGenerator<SessionEvent> {
    for (const event of options.nestedEvents ?? []) yield event;
    if (options.holdNested) {
      await Promise.race([released.promise, options.holdNestedPastCancel ? new Promise(() => {}) : cancelled.promise]);
    }
    for (const event of options.nestedLateEvents ?? []) yield event;
    const end = turnEndEvent("nested done", control.nestedCostUsd);
    yield end.type === "turn_end" && options.nestedStatus === "cancelled" ? { ...end, status: "cancelled" } : end;
  }

  _openChatSessionDeps.randomUUID = () => `chat-${++counter}`;
  _openChatSessionDeps.now = () => NOW;
  _openChatSessionDeps.nativeBackend = (backendOptions) => {
    chatBackends.push(backendOptions);
    return backend;
  };
  _openChatSessionDeps.resolveRuleSet = async () => ({
    rules: [],
    repoRulesTotal: 0,
    repoRulesMatchedPaths: 0,
    packageRulesCount: 0,
  });
  _openChatSessionDeps.createAgentSession = async (sessionOptions) => {
    const session = makeScriptedSession(sessionOptions.sessionId ?? `chat-session-${chatSessions.length}`, chatTurn);
    chatSessions.push(session);
    return session;
  };
  _subagentSessionDeps.nativeBackend = (backendOptions) => {
    nestedBackends.push(backendOptions);
    return backend;
  };
  _subagentSessionDeps.createMemoryTranscriptStore = createMemoryTranscriptStore;
  _subagentSessionDeps.resolveRuleSet = _openChatSessionDeps.resolveRuleSet;
  _subagentSessionDeps.createAgentSession = async (sessionOptions) => {
    nestedSessionOptions.push(sessionOptions);
    const session = makeScriptedSession(`nested-${nestedSessions.length + 1}`, nestedTurn, {
      onCancel: () => cancelled.resolve(),
      ...(options.holdNestedClose ? { closeGate: closeGate.promise } : {}),
    });
    nestedSessions.push(session);
    return session;
  };

  const host = createChatHost({
    config,
    cwd: dir,
    repoRoot: dir,
    chain: null,
    storage,
    now: () => NOW,
    logger: makeLogger(),
    resources,
  });

  return {
    host,
    config,
    resources,
    storage,
    chatSessions,
    chatBackends,
    nestedSessions,
    nestedSessionOptions,
    nestedBackends,
    toolResults,
    turnSignal: () => turn?.signal,
    abortTurn: () => turn?.abort(),
    releaseNested: () => released.resolve(),
    releaseNestedClose: () => closeGate.resolve(),
    releaseChat: () => chatGate.resolve(),
    control,
    agentsProvider,
    async storeSession(id, mode = "ask") {
      await storage.writeMeta({
        schemaVersion: 1,
        sessionId: id,
        cwd: dir,
        mode,
        model: CHAT_MODEL,
        bashApproval: mode === "full" ? "raw" : "gated",
        title: null,
        createdAt: AT,
        updatedAt: AT,
      });
    },
    async dispose() {
      released.resolve();
      cancelled.resolve();
      closeGate.resolve();
      chatGate.resolve();
      try {
        await host.close();
      } finally {
        Object.assign(_openChatSessionDeps, originalOpen);
        Object.assign(_subagentSessionDeps, originalNested);
        cleanupTempDir(dir);
      }
    },
  };
}
