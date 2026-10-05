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
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type StopReason,
} from "@agentclientprotocol/sdk";
import type { FakeHooks, FakeScript, FakeStep, FakeTurn, RpcFailure } from "./script.ts";

const DEFAULT_TURN: FakeTurn = { steps: [{ kind: "text", text: "ok" }] };

interface PromptState {
  readonly cancelled: Promise<void>;
  readonly markCancelled: () => void;
}

function newPromptState(): PromptState {
  let mark: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { cancelled, markCancelled: () => mark() };
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
    case "permission": {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: "fake-permission", title: "Edit a file", kind: "edit", status: "pending" },
        options: step.options.map((kind): PermissionOption => ({ optionId: `opt-${kind}`, name: kind, kind })),
      });
      hooks.record("permission-outcome", response.outcome);
      return undefined;
    }
    case "waitForCancel":
      await state.cancelled;
      return "cancelled";
    case "hang":
      return never();
    case "exit":
      return hooks.exit(step.code, step.stderr);
    case "fail":
      throw rpcError(step.failure);
  }
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
      prompt = newPromptState();
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
