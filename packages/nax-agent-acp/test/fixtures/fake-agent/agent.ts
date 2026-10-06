/**
 * The fake ACP agent (S4 spec §9) on the SDK's agent side. It answers initialize,
 * session/new, session/set_config_option, session/prompt and session/close from a
 * FakeScript and records each request through FakeHooks. It runs in process (the
 * client connects to the AgentApp directly) or as a subprocess (main.ts). Erasable
 * TypeScript only: Node runs it with type stripping.
 */
import {
  type AgentApp,
  type AgentContext,
  agent,
  type McpServer,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { callMcpTool, httpServerOf } from "./mcp.ts";
import type { FakeHooks, FakeScript, FakeStep, FakeTurn, McpCallStep, PermissionStep, RpcFailure } from "./script.ts";

const DEFAULT_TURN: FakeTurn = { steps: [{ kind: "text", text: "ok" }] };

interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
  /** Detached permission requests and MCP calls of this prompt, settled when answered. */
  readonly detached: Promise<void>[];
  /** The mcpServers session/new received. */
  readonly mcpServers: readonly McpServer[];
}

function newPromptState(mcpServers: readonly McpServer[]): PromptState {
  let mark: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { cancelled, markCancelled: () => mark(), detached: [], mcpServers };
}

function withMcpAuth(failure: RpcFailure, servers: readonly McpServer[]): RpcFailure {
  return { ...failure, message: `${failure.message} ${httpServerOf(servers)?.headers.Authorization ?? ""}` };
}

function mcpStep(step: McpCallStep, state: PromptState, hooks: FakeHooks): Promise<void> {
  const call = callMcpTool(step, state.mcpServers, hooks);
  if (step.detached !== true) return call;
  state.detached.push(call);
  return Promise.resolve();
}

function rpcError(failure: RpcFailure): RequestError {
  return new RequestError(failure.code, failure.message);
}

function never(): Promise<never> {
  return new Promise(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(
  step: FakeStep,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<StopReason | undefined> {
  switch (step.kind) {
    case "text":
      await client.notify(methods.client.session.update, {
        sessionId: step.sessionId ?? sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } },
      });
      return undefined;
    case "thought":
      await client.notify(methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.text } },
      });
      return undefined;
    case "delay":
      await sleep(step.ms);
      return undefined;
    case "permission":
      await requestPermission(step, sessionId, client, state, hooks);
      return undefined;
    case "settled":
      await Promise.all(state.detached);
      return undefined;
    case "awaitCancel":
      await state.cancelled;
      return undefined;
    case "waitForCancel":
      await state.cancelled;
      return "cancelled";
    case "hang":
      return never();
    case "mcpCall":
      await mcpStep(step, state, hooks);
      return undefined;
    case "exit":
      return hooks.exit(step.code, step.stderr);
    case "fail":
      throw rpcError(step.echoMcpAuth === true ? withMcpAuth(step.failure, state.mcpServers) : step.failure);
  }
}

async function requestPermission(
  step: PermissionStep,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<void> {
  const toolCallId = step.toolCall?.toolCallId ?? "fake-permission";
  const answered = client
    .request(methods.client.session.requestPermission, {
      sessionId: step.sessionId ?? sessionId,
      toolCall: {
        toolCallId: "fake-permission",
        title: "Edit a file",
        kind: "edit",
        status: "pending",
        ...step.toolCall,
      },
      options: step.options.map((kind): PermissionOption => ({ optionId: `opt-${kind}`, name: kind, kind })),
    })
    .then(
      (response) => {
        hooks.record("permission-outcome", response.outcome);
        hooks.record("permission-answer", { toolCallId, outcome: response.outcome });
      },
      (error: unknown) => {
        hooks.record("permission-error", { toolCallId, message: String(error) });
      },
    );
  if (step.detached === true) {
    state.detached.push(answered);
    return;
  }
  await answered;
}

async function runTurn(
  turn: FakeTurn,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<PromptResponse> {
  for (const step of turn.steps) {
    const stop = await runStep(step, sessionId, client, state, hooks);
    if (stop !== undefined) return { stopReason: stop };
  }
  return { stopReason: turn.stopReason ?? "end_turn", ...(turn.usage === undefined ? {} : { usage: turn.usage }) };
}

export function buildFakeAgent(script: FakeScript, hooks: FakeHooks): AgentApp {
  const sessionId = script.sessionId ?? "fake-session-1";
  const turns = script.turns ?? [DEFAULT_TURN];
  const configOptions = [...(script.configOptions ?? [])];
  let promptCount = 0;
  let prompt: PromptState | undefined;
  let mcpServers: readonly McpServer[] = [];
  return agent({ name: "fake-agent" })
    .onRequest(methods.agent.initialize, async (ctx) => {
      hooks.record("initialize", ctx.params);
      if (script.hangInitialize === true) return never();
      if (script.initializeFailure !== undefined) throw rpcError(script.initializeFailure);
      return {
        protocolVersion: script.protocolVersion ?? PROTOCOL_VERSION,
        agentCapabilities: script.capabilities ?? {},
        ...(script.agentInfo === undefined ? {} : { agentInfo: script.agentInfo }),
      };
    })
    .onRequest(methods.agent.session.new, async (ctx) => {
      hooks.record("session/new", ctx.params);
      mcpServers = ctx.params.mcpServers;
      if (script.newSessionFailure !== undefined) throw rpcError(script.newSessionFailure);
      return { sessionId, ...(script.configOptions === undefined ? {} : { configOptions }) };
    })
    .onRequest(methods.agent.session.setConfigOption, async (ctx) => {
      hooks.record("session/set_config_option", ctx.params);
      if (!configOptions.some((option) => option.id === ctx.params.configId)) {
        throw RequestError.invalidParams(undefined, `unknown config option ${ctx.params.configId}`);
      }
      return { configOptions };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      hooks.record("session/prompt", ctx.params);
      const turn = turns[Math.min(promptCount, turns.length - 1)] ?? DEFAULT_TURN;
      promptCount += 1;
      prompt = newPromptState(mcpServers);
      return runTurn(turn, ctx.params.sessionId, ctx.client, prompt, hooks);
    })
    .onRequest(methods.agent.session.close, async (ctx) => {
      hooks.record("session/close", ctx.params);
      return {};
    })
    .onNotification(methods.agent.session.cancel, (ctx) => {
      hooks.record("session/cancel", ctx.params);
      prompt?.markCancelled();
    });
}
