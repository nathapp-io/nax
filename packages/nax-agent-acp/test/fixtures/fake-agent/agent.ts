/**
 * The fake ACP agent (S4 spec §9) on the SDK's agent side. It answers initialize,
 * session/new, session/resume, session/load, session/set_config_option, session/prompt
 * and session/close from a FakeScript, sends updates, permission requests, MCP calls
 * and elicitations as its steps say, and records each request through FakeHooks. It
 * runs in process (the client connects to the AgentApp directly) or as a subprocess
 * (main.ts). Erasable TypeScript only: Node runs it with type stripping.
 */
import {
  type AgentApp,
  type AgentContext,
  agent,
  type CreateElicitationRequest,
  type McpServer,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { callMcpTool, httpServerOf } from "./mcp.ts";
import type {
  ElicitStep,
  FakeHooks,
  FakeScript,
  FakeStep,
  FakeTurn,
  McpCallStep,
  PermissionStep,
  RpcFailure,
} from "./script.ts";

const DEFAULT_TURN: FakeTurn = { steps: [{ kind: "text", text: "ok" }] };

interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
  /** Detached permission requests, MCP calls and elicitations of this prompt, settled when answered. */
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
    case "text": {
      const auth = step.echoMcpAuth === true ? (httpServerOf(state.mcpServers)?.headers.Authorization ?? "") : "";
      await client.notify(methods.client.session.update, {
        sessionId: step.sessionId ?? sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${step.text}${auth}` } },
      });
      return undefined;
    }
    case "update":
      await client.notify(methods.client.session.update, { sessionId, update: step.update });
      return undefined;
    case "elicit":
      await elicit(step, sessionId, client, state, hooks);
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

function elicitationRequest(step: ElicitStep, sessionId: string): CreateElicitationRequest {
  const scope =
    step.scope === "request"
      ? { requestId: "fake-request-1" }
      : { sessionId: step.scope === "other" ? "other-session" : sessionId };
  if (step.mode === "url") {
    return {
      ...scope,
      mode: "url",
      message: step.message,
      elicitationId: "fake-elicitation-1",
      url: "https://example.com/auth",
    };
  }
  const requestedSchema = step.requestedSchema ?? { type: "object", properties: {} };
  return { ...scope, mode: "form", message: step.message, requestedSchema };
}

async function elicit(
  step: ElicitStep,
  sessionId: string,
  client: AgentContext,
  state: PromptState,
  hooks: FakeHooks,
): Promise<void> {
  const answered = client.request(methods.client.elicitation.create, elicitationRequest(step, sessionId)).then(
    (response) => {
      hooks.record("elicitation-answer", response);
    },
    (error: unknown) => {
      hooks.record("elicitation-error", { message: String(error) });
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

/** Resume and load fail as scripted, or with resourceNotFound for a session the agent does not hold (D6-l). */
function checkRestore(script: FakeScript, ownId: string, requested: string): void {
  if (script.restoreFailure !== undefined) throw rpcError(script.restoreFailure);
  if (!(script.knownSessions ?? [ownId]).includes(requested)) throw RequestError.resourceNotFound(requested);
}

/** A resume/load answer. Claude's adapter also echoes the session id, outside the protocol's schema (D6-d). */
function restoredResponse(script: FakeScript, configOptions: readonly SessionConfigOption[]): ResumeSessionResponse {
  const response = {
    ...(script.configOptions === undefined ? {} : { configOptions: [...configOptions] }),
    ...(script.restoredSessionId === undefined ? {} : { sessionId: script.restoredSessionId }),
  };
  return response;
}

/** session/load's history replay: updates, then optionally one permission request. */
async function replay(script: FakeScript, sessionId: string, client: AgentContext, hooks: FakeHooks): Promise<void> {
  for (const update of script.loadReplay ?? []) {
    await client.notify(methods.client.session.update, { sessionId, update });
  }
  if (script.loadPermission !== true) return;
  const response = await client.request(methods.client.session.requestPermission, {
    sessionId,
    toolCall: { toolCallId: "replay-permission", title: "Replay an edit", kind: "edit", status: "pending" },
    options: [
      { optionId: "opt-allow_once", name: "allow_once", kind: "allow_once" },
      { optionId: "opt-reject_once", name: "reject_once", kind: "reject_once" },
    ],
  });
  hooks.record("load-permission-outcome", response.outcome);
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
    .onRequest(methods.agent.session.resume, async (ctx) => {
      hooks.record("session/resume", ctx.params);
      mcpServers = ctx.params.mcpServers ?? [];
      checkRestore(script, sessionId, ctx.params.sessionId);
      return restoredResponse(script, configOptions);
    })
    .onRequest(methods.agent.session.load, async (ctx) => {
      hooks.record("session/load", ctx.params);
      mcpServers = ctx.params.mcpServers;
      checkRestore(script, sessionId, ctx.params.sessionId);
      await replay(script, ctx.params.sessionId, ctx.client, hooks);
      return restoredResponse(script, configOptions);
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
