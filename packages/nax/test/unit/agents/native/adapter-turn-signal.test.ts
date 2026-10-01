/**
 * US-002 — the native adapter's one per-turn signal reaching in-flight work.
 *
 * These pin the adapter end of the turn-signal story: `sendTurn` must build a
 * single turn signal from the watchdog `turnController`, the caller's
 * `opts.signal` and a whole-turn deadline, thread it through `runNativeTurn` →
 * `runToolBatch` → the coding-tool request → `ToolCallContext` →
 * `ToolRunContext`, so an in-flight tool observes the abort. The unit halves
 * of that chain (batch → request, handler → context, context → run tool) are
 * pinned in `turn-loop-cancel.test.ts`, `run-interaction-handler.test.ts` and
 * `runtime.test.ts`; this file drives the whole path through the real
 * `NativeAgentAdapter` with a fake client and a real coding-tool runtime.
 *
 * AC10  — onActiveCall cancel during a coding tool's execution aborts the
 *         signal that tool received in its ToolRunContext.
 * AC11  — same, aborting the caller's `opts.signal` instead.
 * AC12  — a tool still running when the turn's deadline passes receives an
 *         aborted signal (awaited with waitForCondition, never a fixed sleep).
 * AC13  — onActiveCall cancel during a complete request aborts the signal
 *         that request receives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { makeFakeClock, waitForCondition } from "@test/helpers";
import type { InteractionHandler } from "@/agents/interaction-handler";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { clearNativeSessionState } from "@/agents/native/session/session";
import type { CodingTool } from "@/tools";
import { compileToolPolicy, createCodingToolRuntime } from "@/tools";

const REAL_BUILD = _clientDeps.build;
const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;
const REAL_SET_TIMEOUT = _adapterDeps.setTimeout;
const REAL_CLEAR_TIMEOUT = _adapterDeps.clearTimeout;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
  _adapterDeps.setTimeout = REAL_SET_TIMEOUT;
  _adapterDeps.clearTimeout = REAL_CLEAR_TIMEOUT;
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

function fakeClient(over: Record<string, unknown> = {}): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({
      text: "ok",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "stop",
    }),
    validate: () => {},
    ...over,
  };
}

/** Round 1 offers one Read tool call; every later round closes the turn. */
function toolTurnClient(): Client {
  let calls = 0;
  return fakeClient({
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: "tool_use" as const,
        };
      }
      return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
    },
  });
}

/** A Read whose run captures ctx.signal and blocks on `gate` until released. */
function blockingReadTool(captured: { signal?: AbortSignal }, gate: Promise<void>): CodingTool {
  return {
    name: "Read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    scope: { pathFields: ["path"] },
    async run(_input, ctx) {
      captured.signal = ctx.signal;
      await gate;
      return { content: "ok" };
    },
  };
}

/**
 * The handler a native run is driven with in this file: forward the request's
 * signal and onWaiting into a real coding-tool runtime, exactly as
 * `buildRunInteractionHandler` does, so the signal reaches the tool's
 * ToolRunContext and is observable.
 */
function toolInteractionHandler(runtime: ReturnType<typeof createCodingToolRuntime>): InteractionHandler {
  return {
    async onInteraction(req) {
      if (req.kind !== "coding-tool") return { answer: "" };
      const outcome = await runtime.callTool(req.name, req.input ?? {}, {
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
        ...(req.onWaiting !== undefined ? { onWaiting: req.onWaiting } : {}),
      });
      if (outcome.kind === "denied") return { answer: `Denied: ${outcome.reason}` };
      return { answer: outcome.content };
    },
  };
}

describe("NativeAgentAdapter — turn signal following an in-flight call (US-002)", () => {
  test("AC10: onActiveCall cancel during a coding tool's execution aborts the signal that tool received", async () => {
    const root = await mkdtemp(join(tmpdir(), "nax-turn-signal-root-"));
    const captured: { signal?: AbortSignal } = {};
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockingTool = blockingReadTool(captured, gate);
    const codingToolRuntime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      extraTools: [blockingTool],
    });
    let cancel: (() => Promise<void>) | undefined;
    _clientDeps.build = async () => toolTurnClient();
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-turn-signal-"));
    const handle = await adapter.openSession("sess-turn-signal-10", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
      onActiveCall: async (_callId, c) => {
        cancel = c;
      },
    });

    const turn = adapter
      .sendTurn(handle, "hi", {
        interactionHandler: toolInteractionHandler(codingToolRuntime),
        codingTools: [blockingTool],
      })
      .catch(() => {});
    try {
      await waitForCondition(() => captured.signal !== undefined, 1000).catch(() => {});
      expect(captured.signal).toBeDefined();
      await cancel?.();
      await waitForCondition(() => captured.signal?.aborted === true, 1000).catch(() => {});
      expect(captured.signal?.aborted).toBe(true);
    } finally {
      release?.();
      await turn;
      clearNativeSessionState(handle.id);
    }
  });

  test("AC11: aborting caller opts.signal during a coding tool's execution aborts the signal that tool received", async () => {
    const root = await mkdtemp(join(tmpdir(), "nax-turn-signal-root-"));
    const captured: { signal?: AbortSignal } = {};
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blockingTool = blockingReadTool(captured, gate);
    const codingToolRuntime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      extraTools: [blockingTool],
    });
    const callerController = new AbortController();
    _clientDeps.build = async () => toolTurnClient();
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-turn-signal-"));
    const handle = await adapter.openSession("sess-turn-signal-11", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
    });

    const turn = adapter
      .sendTurn(handle, "hi", {
        interactionHandler: toolInteractionHandler(codingToolRuntime),
        codingTools: [blockingTool],
        signal: callerController.signal,
      })
      .catch(() => {});
    try {
      await waitForCondition(() => captured.signal !== undefined, 1000).catch(() => {});
      expect(captured.signal).toBeDefined();
      callerController.abort();
      await waitForCondition(() => captured.signal?.aborted === true, 1000).catch(() => {});
      expect(captured.signal?.aborted).toBe(true);
    } finally {
      release?.();
      await turn;
      clearNativeSessionState(handle.id);
    }
  });

  test("AC12: a tool still running when the turn's deadline passes receives an aborted signal", async () => {
    // Drive the 1s whole-turn deadline off a virtual clock so this test costs
    // no wall-clock. The schema minimum (1s) is the contract under test, not
    // the real-time wait; advancing a fake clock by exactly that amount
    // proves the deadline branch resolves correctly and deterministically.
    const clock = makeFakeClock();
    _adapterDeps.setTimeout = clock.setTimeout as typeof _adapterDeps.setTimeout;
    _adapterDeps.clearTimeout = clock.clearTimeout as typeof _adapterDeps.clearTimeout;

    const root = await mkdtemp(join(tmpdir(), "nax-turn-signal-root-"));
    const captured: { signal?: AbortSignal } = {};
    // The tool never finishes; only the turn's whole-turn deadline can
    // interrupt it.
    const gate = new Promise<never>(() => {});
    const blockingTool = blockingReadTool(captured, gate);
    const codingToolRuntime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      extraTools: [blockingTool],
    });
    _clientDeps.build = async () => toolTurnClient();
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-turn-signal-"));
    const handle = await adapter.openSession("sess-turn-signal-12", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 1,
      transcriptDir,
    });

    void adapter
      .sendTurn(handle, "hi", {
        interactionHandler: toolInteractionHandler(codingToolRuntime),
        codingTools: [blockingTool],
      })
      .catch(() => {});

    try {
      // Two advances: the first lets the turn start and arm the deadline
      // timer (the sendTurn's `await Promise.resolve()` chain settles the
      // session-open microtasks, then `deadlineMs` schedules the abort).
      // The second fires the deadline, aborting `deadlineController.signal`,
      // which `AbortSignal.any` forwards to the tool's `captured.signal`.
      await clock.advance(0);
      await waitForCondition(() => captured.signal !== undefined, 1000).catch(() => {});
      expect(captured.signal).toBeDefined();
      await clock.advance(1_000);
      await waitForCondition(() => captured.signal?.aborted === true, 1000).catch(() => {});
      expect(captured.signal?.aborted).toBe(true);
    } finally {
      clearNativeSessionState(handle.id);
    }
  });

  test("AC13: onActiveCall cancel during a complete request aborts the signal that request receives", async () => {
    const root = await mkdtemp(join(tmpdir(), "nax-turn-signal-root-"));
    let capturedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    _clientDeps.build = async () =>
      fakeClient({
        complete: async (_m: ResolvedModel, req: { signal?: AbortSignal }) => {
          capturedSignal = req.signal;
          await gate;
          return { text: "done", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
        },
      });
    let cancel: (() => Promise<void>) | undefined;
    const adapter = new NativeAgentAdapter();
    const transcriptDir = await mkdtemp(join(tmpdir(), "nax-adapter-turn-signal-"));
    const handle = await adapter.openSession("sess-turn-signal-13", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 60,
      transcriptDir,
      onActiveCall: async (_callId, c) => {
        cancel = c;
      },
    });

    const turn = adapter
      .sendTurn(handle, "hi", {
        interactionHandler: { onInteraction: async () => ({ answer: "" }) },
      })
      .catch(() => {});
    try {
      await waitForCondition(() => capturedSignal !== undefined, 1000);
      expect(capturedSignal).toBeDefined();
      await cancel?.();
      await waitForCondition(() => capturedSignal?.aborted === true, 1000).catch(() => {});
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      release?.();
      await turn;
      clearNativeSessionState(handle.id);
    }
  });
});
