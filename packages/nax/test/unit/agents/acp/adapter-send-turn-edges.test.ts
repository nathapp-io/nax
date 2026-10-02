/**
 * Characterisation tests for sendTurn() branches nothing else pins.
 *
 * Written before the B2 complexity drain of `sendTurn` (adapter.ts), green
 * against the unrefactored implementation. The phase-a / rate-card mirrors pin
 * the main flows; this file pins the edges:
 *
 *  1. The loop-top wall-clock deadline check (the deadline expiring BETWEEN
 *     iterations, e.g. because an interaction handler consumed the budget) —
 *     distinct from runSessionPrompt's own in-flight timeout.
 *  2. The "Interaction budget spent" warn, including the default
 *     maxInteractions of 10.
 *  3. NO_SESSION recovery whose re-establishment itself throws: the warn is
 *     emitted and the dead turn's stopReason:"error" still surfaces as a
 *     SessionTurnError (the documented "fall through to error throw" path).
 *  4. The externally-cancelled SessionTurnError message variant and the
 *     retryable flag.
 *  5. The pre-aborted zero-cost row stamping pricingSource from the handle's
 *     resolved rate card (US-002).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NO_OP_INTERACTION_HANDLER } from "@nathapp/nax-agent";
import { SessionTurnError } from "@/agents";
import { _acpAdapterDeps, AcpAgentAdapter } from "@/agents/acp/adapter";
import type { RateCard } from "@/agents/cost";
import type { OpenSessionOpts } from "@/agents/types";
import { toPricing } from "@/config/schema-types";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { makeClient, makeSession } from "./adapter.test";

const ACP_WORKDIR = "/tmp/nax-sendturn-edges-test";

const FALLBACK_CARD: RateCard = {
  rates: toPricing({ inputPer1M: 3, outputPer1M: 15 }),
  source: "fallback-rates",
};

function makeOpenSessionOpts(overrides: Partial<OpenSessionOpts> = {}): OpenSessionOpts {
  return {
    agentName: "claude",
    workdir: ACP_WORKDIR,
    resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    timeoutSeconds: 30,
    ...overrides,
  };
}

describe("sendTurn — characterised edges (pre-B2)", () => {
  let adapter: AcpAgentAdapter;
  let origCreateClient: typeof _acpAdapterDeps.createClient;
  let origResolveRateCard: typeof _acpAdapterDeps.resolveRateCard;
  let logCalls: LogEntry[];

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    origResolveRateCard = _acpAdapterDeps.resolveRateCard;
    adapter = new AcpAgentAdapter("claude");
    logCalls = [];
    initLogger({ level: "silent" });
    addSink((entry) => logCalls.push(entry));
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.resolveRateCard = origResolveRateCard;
    mock.restore();
    resetLogger();
  });

  async function openHandle(
    session = makeSession(),
    clientOverrides = {},
    optsOverrides: Partial<OpenSessionOpts> = {},
  ) {
    const client = makeClient(session, clientOverrides);
    _acpAdapterDeps.createClient = mock(() => client);
    return adapter.openSession("nax-sendturn-edges", makeOpenSessionOpts(optsOverrides));
  }

  test("deadline expiring between iterations (slow interaction handler): timedOut result, one round-trip, wall-clock warn", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "Should I proceed with approach A or B?" }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const handle = await openHandle(session, {}, { timeoutSeconds: 0.1 });

    const result = await adapter.sendTurn(handle, "prompt", {
      // The handler answers after the 100ms turn deadline has passed, so the
      // next loop-top expired() check ends the turn — not runSessionPrompt's
      // in-flight timeout, which never fires (each prompt resolves fast).
      interactionHandler: {
        onInteraction: async () => {
          await Bun.sleep(300);
          return { answer: "Use approach A." };
        },
      },
    });

    expect(result.timedOut).toBe(true);
    expect(result.output).toBe("");
    expect(result.internalRoundTrips).toBe(1);
    const warn = logCalls.find((entry) => entry.message.includes("wall-clock timeout exceeded"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    expect(warn?.stage).toBe("acp-adapter");
    expect(warn?.data?.sessionName).toBe("nax-sendturn-edges");
  });

  test("default interaction budget of 10 is spent: 10 round-trips and the budget warn with its payload", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [{ role: "assistant", content: "Should I proceed?" }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });
    const handle = await openHandle(session);

    const result = await adapter.sendTurn(handle, "prompt", {
      // Answers every question: the loop only ends when the DEFAULT budget
      // (no maxInteractions passed) is exhausted.
      interactionHandler: {
        onInteraction: async () => ({ answer: "yes" }),
      },
    });

    expect(result.internalRoundTrips).toBe(10);
    expect(result.timedOut).toBe(false);
    const warn = logCalls.find((entry) => entry.message.includes("Interaction budget spent"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    expect(warn?.data?.sessionName).toBe("nax-sendturn-edges");
    expect(warn?.data?.maxInteractions).toBe(10);
  });

  test("NO_SESSION recovery whose re-establishment throws: warn logged, then the dead turn's error surfaces", async () => {
    const deadPromptFn = async () => ({
      messages: [{ role: "assistant", content: "NO_SESSION" }],
      stopReason: "error",
      exitCode: 4,
    });
    const session = makeSession({ promptFn: deadPromptFn });
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);
    const handle = await adapter.openSession("nax-sendturn-edges", makeOpenSessionOpts());

    // Break both re-establishment routes only AFTER the session is open, so
    // the failure is confined to the recovery path inside sendTurn.
    client.loadSession = async () => {
      throw new Error("loadSession exploded");
    };
    client.createSession = async () => {
      throw new Error("createSession exploded");
    };

    let caught: unknown;
    try {
      await adapter.sendTurn(handle, "do the work", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    } catch (err) {
      caught = err;
    }

    if (!(caught instanceof SessionTurnError)) {
      throw new Error("expected SessionTurnError");
    }
    expect(caught.message).toContain("stop reason: error");
    const warn = logCalls.find((entry) => entry.message.includes("Session re-establishment failed after NO_SESSION"));
    expect(warn).toBeDefined();
    expect(warn?.level).toBe("warn");
    expect(warn?.data?.sessionName).toBe("nax-sendturn-edges");
    expect(String(warn?.data?.error)).toContain("createSession exploded");
  });

  test("externally-cancelled error turn: message names the external cancel and retryable is carried", async () => {
    const session = makeSession({
      promptFn: async () => ({
        messages: [],
        stopReason: "error",
        cancelled: true,
        retryable: true,
        cumulative_token_usage: { input_tokens: 5, output_tokens: 5 },
      }),
    });
    const handle = await openHandle(session);

    let caught: unknown;
    try {
      await adapter.sendTurn(handle, "prompt", { interactionHandler: NO_OP_INTERACTION_HANDLER });
    } catch (err) {
      caught = err;
    }

    if (!(caught instanceof SessionTurnError)) {
      throw new Error("expected SessionTurnError");
    }
    expect(caught.message).toBe("Agent session ended with stop reason: error (externally cancelled)");
    expect(caught.cancelled).toBe(true);
    expect(caught.retryable).toBe(true);
  });

  test("pre-aborted turn: zero-cost row still stamps pricingSource from the handle's rate card", async () => {
    _acpAdapterDeps.resolveRateCard = mock(async () => FALLBACK_CARD);
    const session = makeSession();
    const client = makeClient(session);
    _acpAdapterDeps.createClient = mock(() => client);
    const handle = await adapter.openSession("nax-sendturn-edges-abort", makeOpenSessionOpts());

    const controller = new AbortController();
    controller.abort();
    const result = await adapter.sendTurn(handle, "prompt", {
      interactionHandler: NO_OP_INTERACTION_HANDLER,
      signal: controller.signal,
    });

    expect(result.internalRoundTrips).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.pricingSource).toBe("fallback-rates");
  });
});
