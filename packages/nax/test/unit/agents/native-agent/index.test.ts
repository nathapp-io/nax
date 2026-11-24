/**
 * nax's NativeAgentAdapter shell (S1 port 2): process-description members
 * answered locally, session methods forwarded, complete() mapped onto
 * nativeComplete with config pricing converted on the way.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentSessionAdapter, OpenSessionOpts, SendTurnOpts, SessionHandle, TurnResult } from "@nathapp/nax-agent";
import { _clientDeps, _resetNativeClient } from "@nathapp/nax-agent/internal";
import type { Client, ClientRequest, ResolvedModel } from "@nathapp/nax-ai";
import { assertDefined } from "@test/helpers";
import { NativeAgentAdapter } from "@/agents/native-agent";
import type { ResolvedCompleteOptions } from "@/agents/types";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const HANDLE: SessionHandle = { id: "s", agentName: "native" };
const TURN: TurnResult = {
  output: "t",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};
const OPEN_OPTS: OpenSessionOpts = {
  agentName: "native",
  workdir: "/w",
  resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  modelDef: { provider: "p", model: "p/m" },
  timeoutSeconds: 1,
};
const SEND_OPTS: SendTurnOpts = { interactionHandler: { onInteraction: async () => null } };

function recordingSessions(): { calls: Array<[string, unknown[]]>; sessions: Required<AgentSessionAdapter> } {
  const calls: Array<[string, unknown[]]> = [];
  const sessions: Required<AgentSessionAdapter> = {
    // `true`, not `false`: a shell that hardcoded the answer and never called
    // the session adapter would satisfy a `false` expectation, so the one
    // forward whose VALUE is asserted is the one a hardcoded answer cannot pass.
    hasCredentials: async (...a) => {
      calls.push(["hasCredentials", a]);
      return true;
    },
    openSession: async (...a) => {
      calls.push(["openSession", a]);
      return HANDLE;
    },
    sendTurn: async (...a) => {
      calls.push(["sendTurn", a]);
      return TURN;
    },
    closeSession: async (...a) => {
      calls.push(["closeSession", a]);
    },
    closePhysicalSession: async (...a) => {
      calls.push(["closePhysicalSession", a]);
    },
  };
  return { calls, sessions };
}

describe("NativeAgentAdapter shell", () => {
  test("forwards every session method with its arguments", async () => {
    const { calls, sessions } = recordingSessions();
    const adapter = new NativeAgentAdapter(undefined, [], sessions);
    const handle = HANDLE;
    expect(await adapter.hasCredentials()).toBe(true);
    expect(await adapter.openSession("s", OPEN_OPTS)).toBe(HANDLE);
    expect(await adapter.sendTurn(handle, "p", SEND_OPTS)).toBe(TURN);
    await adapter.closeSession(handle);
    await adapter.closePhysicalSession("s", "/w", { force: true });
    expect(calls.map(([m]) => m)).toEqual([
      "hasCredentials",
      "openSession",
      "sendTurn",
      "closeSession",
      "closePhysicalSession",
    ]);
    // Every forward's arguments, not just its name and position: an argument
    // dropped from a call still typechecks and still records the call.
    expect(calls[1]?.[1]).toEqual(["s", OPEN_OPTS]);
    expect(calls[2]?.[1]).toEqual([HANDLE, "p", SEND_OPTS]);
    expect(calls[3]?.[1]).toEqual([HANDLE]);
    expect(calls[4]?.[1]).toEqual(["s", "/w", { force: true }]);
  });

  test("answers the process-description members itself", async () => {
    const adapter = new NativeAgentAdapter([]);
    expect(adapter.name).toBe("native");
    expect(adapter.binary).toBe("");
    expect(adapter.buildCommand()).toEqual([]);
    expect(await adapter.isInstalled()).toBe(true);
    expect(adapter.capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
  });

  test("complete() converts a config pricing override before pricing", async () => {
    const model = {
      id: "gpt-5.4-mini",
      provider: "openai",
      protocol: "openai-responses",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 128_000,
      supportsTools: true,
      thinkingLevels: [],
    } satisfies ResolvedModel;
    _clientDeps.build = async () =>
      ({
        model: async () => model,
        listModels: async () => [model],
        pricing: () => model.pricing,
        stream: async function* stream() {},
        complete: async () => ({
          text: "ok",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
          stopReason: "stop",
        }),
        validate: () => {},
      }) satisfies Client;
    const options: ResolvedCompleteOptions = {
      modelDef: { provider: "openai", model: "openai/gpt-5.4-mini", pricing: { inputPer1M: 2, outputPer1M: 8 } },
      workdir: "/w",
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
    };
    const out = await new NativeAgentAdapter().complete("hi", options);
    expect(out.pricingSource).toBe("config-override");
    // cacheRead was absent in config, so it takes the input rate (2 per 1M).
    expect(out.rates?.cacheRead).toBe(2);
    expect(out.estimatedCostUsd).toBe(2);
  });

  test("US-003 AC-8: forwards options.signal so a caller abort cancels the request in flight", async () => {
    const model = {
      id: "gpt-5.4-mini",
      provider: "openai",
      protocol: "openai-responses",
      pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 128_000,
      supportsTools: true,
      thinkingLevels: [],
    } satisfies ResolvedModel;
    const caller = new AbortController();
    const seen: ClientRequest[] = [];
    const pending = Promise.withResolvers<Awaited<ReturnType<Client["complete"]>>>();
    const inFlight = Promise.withResolvers<void>();
    _clientDeps.build = async () =>
      ({
        model: async () => model,
        listModels: async () => [model],
        pricing: () => model.pricing,
        stream: async function* stream() {},
        complete: async (_resolved, req) => {
          seen.push(req);
          inFlight.resolve();
          return pending.promise;
        },
        validate: () => {},
      }) satisfies Client;

    const call = new NativeAgentAdapter().complete("hi", {
      modelDef: { provider: "openai", model: "openai/gpt-5.4-mini" },
      workdir: "/w",
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      signal: caller.signal,
    });
    await inFlight.promise;

    const requestSignal = seen[0]?.signal;
    assertDefined(requestSignal, "the request signal handed to client.complete");
    expect(requestSignal.aborted).toBe(false);

    caller.abort(new Error("run cancelled"));

    // The request the client already holds is the only thing that reaches the
    // provider — an adapter that drops options.signal leaves it live forever.
    expect(requestSignal.aborted).toBe(true);
    pending.resolve({ text: "ok", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" });
    expect((await call).output).toBe("ok");
  });
});
