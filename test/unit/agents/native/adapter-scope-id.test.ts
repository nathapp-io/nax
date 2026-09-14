/**
 * nax#2045 Task 2: stamp the exact ledger join key on native stream events.
 *
 * The transcript's `owner` and the cost ledger's `scopeId` are the same value
 * (`session-run-hop.ts` sets `transcriptOwner = options.scopeId ?? options.callId`).
 * The stream event's sibling `callId` is a per-turn stream-local UUID and is
 * deliberately NOT that key — joining on it is the issue's own 0-match mistake.
 * These tests pin the scopeId on the native path and its absence off it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { AgentStreamEvent } from "@/runtime/agent-stream-events";

const REAL_BUILD = _clientDeps.build;
const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function fakeClient(): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({
      text: "ok",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      stopReason: "stop",
    }),
    validate: () => {},
  };
}

interface TurnCapture {
  events: AgentStreamEvent[];
  activeCallId?: string;
}

async function runOneTurn(over: { transcriptOwner?: string } = {}): Promise<TurnCapture> {
  _clientDeps.build = async () => fakeClient();
  const events: AgentStreamEvent[] = [];
  const capture: TurnCapture = { events };
  const adapter = new NativeAgentAdapter();
  const handle = await adapter.openSession("sess-scope-id", {
    agentName: "native",
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    timeoutSeconds: 60,
    transcriptDir: await mkdtemp(join(tmpdir(), "nax-adapter-scope-id-")),
    onStreamActivity: (event) => events.push(event),
    onActiveCall: (callId) => {
      capture.activeCallId = callId;
    },
    ...(over.transcriptOwner !== undefined ? { transcriptOwner: over.transcriptOwner } : {}),
  });

  await adapter.sendTurn(handle, "hi", {
    interactionHandler: { onInteraction: async () => ({ answer: "" }) },
  });
  return capture;
}

describe("NativeAgentAdapter stream events carry the transcript/ledger scopeId", () => {
  test("a session opened with a transcriptOwner stamps that exact scopeId on every stream event", async () => {
    const { events } = await runOneTurn({ transcriptOwner: "mu11sq5p-vkwysr" });

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.scopeId).toBe("mu11sq5p-vkwysr");
    }
    const usage = events.find((event) => event.kind === "agent.usage_update");
    expect(usage?.scopeId).toBe("mu11sq5p-vkwysr");
  });

  test("a session opened without a transcriptOwner leaves scopeId absent — never empty, never the stream callId", async () => {
    const { events } = await runOneTurn();

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect("scopeId" in event).toBe(false);
      expect(event.scopeId).toBeUndefined();
    }
  });

  test("the stream callId is unchanged: it stays the onActiveCall handle and never becomes the scopeId", async () => {
    const { events, activeCallId } = await runOneTurn({ transcriptOwner: "mu11sq5p-vkwysr" });

    expect(activeCallId).toBeDefined();
    if (activeCallId === undefined) throw new Error("onActiveCall was not invoked");
    const usage = events.find((event) => event.kind === "agent.usage_update");
    expect(usage).toBeDefined();

    // Every event shares the single stream-local callId the watchdog registered.
    for (const event of events) {
      expect(event.callId).toBe(activeCallId);
    }
    // ...and that id is a different value from the ledger/transcript join key.
    expect(usage?.callId).not.toBe("mu11sq5p-vkwysr");
    expect(usage?.scopeId).toBe("mu11sq5p-vkwysr");
  });
});
