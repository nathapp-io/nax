/**
 * US-003 — the native adapter's own two turn-end aborts name why they fired.
 *
 * `NativeSessionAdapter.sendTurn` aborts for two reasons of its own: the
 * whole-turn deadline timer, and the active-call cancel the idle watchdog
 * reaches through `hooks.onActiveCall`. Both used to call `abort()` with no
 * argument, so the abandoned-tool text could only say "the turn ended" and the
 * user had no way to tell a 600s budget from a watchdog cancel.
 *
 * Each case drives a REAL `NativeSessionAdapter` (fake client, real coding-tool
 * runtime, real session-interaction handler) so the reason travels the
 * production path: adapter → turn signal → tool batch → request signal →
 * `abandonedToolMessage`. The abort source is a test-controlled stub — the
 * first captured `_adapterDeps.setTimeout` callback for the deadline, and the
 * `onActiveCall` cancel function for the cancel — so no wall-clock wait is
 * involved.
 *
 * AC-8 / AC-9 pin the other half of the contract: whatever the reason is, the
 * error `sendTurn` rejects with must still be an `AbortError` by name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps } from "#src/native/adapter-deps";
import { _clientDeps, _resetNativeClient } from "#src/native/client";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import type { InteractionHandler } from "#src/session/interaction-handler";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import { createSessionInteractionHandler } from "#src/session/session-interaction";
import { type CodingTool, compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import { cleanupTempDir, makeTempDir, waitForCondition, withDerivedStream } from "#test/helpers/index";

const tempDirs: string[] = [];
const sessionCleanups: (() => Promise<void>)[] = [];

function makeTestDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

const REAL_BUILD = _clientDeps.build;
const REAL_SET_TIMEOUT = _adapterDeps.setTimeout;
const REAL_CLEAR_TIMEOUT = _adapterDeps.clearTimeout;

afterEach(async () => {
  const closed = await Promise.allSettled(sessionCleanups.splice(0).map(async (close) => close()));
  try {
    const errors = closed.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close test sessions");
  } finally {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    _clientDeps.build = REAL_BUILD;
    _resetNativeClient();
    _adapterDeps.setTimeout = REAL_SET_TIMEOUT;
    _adapterDeps.clearTimeout = REAL_CLEAR_TIMEOUT;
  }
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
  return withDerivedStream({
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
  });
}

/** Round 1 offers one Read tool call; the turn is expected to end inside that call. */
function toolTurnClient(): Client {
  return fakeClient({
    complete: async () => ({
      text: "",
      toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use" as const,
    }),
  });
}

/** A model call that never answers on its own: it settles only when its signal aborts. */
function hangingClient(captured: { signal?: AbortSignal }): Client {
  return fakeClient({
    complete: (_model: ResolvedModel, req: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        captured.signal = req.signal;
        req.signal?.addEventListener("abort", () => reject(req.signal?.reason), { once: true });
      }),
  });
}

/**
 * The one `_adapterDeps.setTimeout` callback the test needs: a stub that
 * records what is armed instead of running it, so the deadline fires when the
 * test says so. Nothing else in this file depends on a timer elapsing.
 */
function captureTimers(): (() => void)[] {
  const callbacks: (() => void)[] = [];
  _adapterDeps.setTimeout = (fn: () => void) => {
    callbacks.push(fn);
    return callbacks.length - 1;
  };
  _adapterDeps.clearTimeout = () => {};
  return callbacks;
}

/** A Read that starts and never settles — only the turn's abort can end its call. */
function neverSettlingRead(started: { value: boolean }): CodingTool {
  return {
    name: "Read",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    scope: { pathFields: ["path"] },
    run() {
      started.value = true;
      return new Promise<never>(() => {});
    },
  };
}

/**
 * The production session-interaction handler over a real coding-tool runtime,
 * wrapped so this file can read the answer the tool's call received. The batch
 * turns a handler throw into the tool result's content verbatim, so the thrown
 * message IS the tool's answer.
 */
function answeringHandler(
  runtime: ReturnType<typeof createCodingToolRuntime>,
  answer: { message?: string },
): InteractionHandler {
  const inner = createSessionInteractionHandler({
    sessionId: "sess-abort-reasons",
    runtime,
    embedderTools: new Map(),
    asks: createSessionAskPort({ table: createPendingAskTable(30_000), emit: () => {}, turn: () => undefined }),
    turnSignal: () => new AbortController().signal,
    setCurrentCallId: () => {},
  });
  return {
    async onInteraction(request) {
      try {
        return await inner.onInteraction(request);
      } catch (err) {
        answer.message = err instanceof Error ? err.message : String(err);
        throw err;
      }
    },
  };
}

/** The error a promise rejects with; throws if it resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const settled = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!(settled instanceof Error)) throw new Error("expected sendTurn to reject with an Error");
  return settled;
}

describe("NativeSessionAdapter — turn-end abort reasons (US-003)", () => {
  test("AC-6: the whole-turn deadline answers an in-flight coding tool with the deadline reason", async () => {
    const timers = captureTimers();
    const root = makeTestDir("nax-abort-reasons-root-");
    const started = { value: false };
    const tool = neverSettlingRead(started);
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      extraTools: [tool],
    });
    const answer: { message?: string } = {};
    _clientDeps.build = async () => toolTurnClient();
    const adapter = new NativeSessionAdapter();
    const handle = await adapter.openSession("sess-abort-reasons-6", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 600,
      transcriptDir: makeTestDir("nax-abort-reasons-transcript-"),
    });
    sessionCleanups.push(() => adapter.closeSession(handle));

    const turn = adapter.sendTurn(handle, "hi", {
      interactionHandler: answeringHandler(runtime, answer),
      codingTools: [tool],
    });
    await waitForCondition(() => started.value, 1000);
    // The deadline timer is armed before the first round trip, so it is the
    // first callback captured; no other captured callback is fired in this
    // test. (The round trip arms its own per-call timer second, and that one
    // deliberately keeps aborting with no reason — out of scope here.)
    //
    // Deliberately no assertion on the captured COUNT: how many timers a turn
    // arms is not this story's behaviour, and a count assertion placed here
    // fails BEFORE the reason is ever observed — which is how a stale count
    // hid the missing deadline reason once already.
    timers[0]?.();
    const err = await rejectionOf(turn);

    expect(answer.message).toBe('Tool "Read" was abandoned: the turn ended (native turn deadline of 600s reached).');
    expect(err.name).toBe("AbortError");
    expect(err.message).toBe("native turn deadline of 600s reached");
  });

  test("AC-7: the active-call cancel answers an in-flight coding tool with the cancel reason", async () => {
    const root = makeTestDir("nax-abort-reasons-root-");
    const started = { value: false };
    const tool = neverSettlingRead(started);
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "Read", patterns: ["*"] }], root),
      extraTools: [tool],
    });
    const answer: { message?: string } = {};
    let cancel: (() => Promise<void>) | undefined;
    _clientDeps.build = async () => toolTurnClient();
    const adapter = new NativeSessionAdapter();
    const handle = await adapter.openSession("sess-abort-reasons-7", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 600,
      transcriptDir: makeTestDir("nax-abort-reasons-transcript-"),
      onActiveCall: async (_callId, cancelActiveCall) => {
        cancel = cancelActiveCall;
      },
    });
    sessionCleanups.push(() => adapter.closeSession(handle));

    const turn = adapter.sendTurn(handle, "hi", {
      interactionHandler: answeringHandler(runtime, answer),
      codingTools: [tool],
    });
    await waitForCondition(() => started.value && cancel !== undefined, 1000);
    await cancel?.();
    const err = await rejectionOf(turn);

    expect(answer.message).toBe(
      'Tool "Read" was abandoned: the turn ended (turn cancelled by its active-call cancel (idle watchdog or soft cancel)).',
    );
    expect(err.name).toBe("AbortError");
  });

  test("AC-8: the error sendTurn rejects with after the deadline fired is an AbortError", async () => {
    const timers = captureTimers();
    const root = makeTestDir("nax-abort-reasons-root-");
    const captured: { signal?: AbortSignal } = {};
    _clientDeps.build = async () => hangingClient(captured);
    const adapter = new NativeSessionAdapter();
    const handle = await adapter.openSession("sess-abort-reasons-8", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 600,
      transcriptDir: makeTestDir("nax-abort-reasons-transcript-"),
    });
    sessionCleanups.push(() => adapter.closeSession(handle));

    const turn = adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });
    await waitForCondition(() => captured.signal !== undefined, 1000);
    expect(captured.signal).toBeDefined();
    timers[0]?.();
    const err = await rejectionOf(turn);

    expect(err.name).toBe("AbortError");
    expect(err.message).toBe("native turn deadline of 600s reached");
  });

  test("AC-9: the error sendTurn rejects with after the active-call cancel is an AbortError", async () => {
    const root = makeTestDir("nax-abort-reasons-root-");
    const captured: { signal?: AbortSignal } = {};
    let cancel: (() => Promise<void>) | undefined;
    _clientDeps.build = async () => hangingClient(captured);
    const adapter = new NativeSessionAdapter();
    const handle = await adapter.openSession("sess-abort-reasons-9", {
      agentName: "native",
      workdir: root,
      resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
      modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
      timeoutSeconds: 600,
      transcriptDir: makeTestDir("nax-abort-reasons-transcript-"),
      onActiveCall: async (_callId, cancelActiveCall) => {
        cancel = cancelActiveCall;
      },
    });
    sessionCleanups.push(() => adapter.closeSession(handle));

    const turn = adapter.sendTurn(handle, "hi", {
      interactionHandler: { onInteraction: async () => ({ answer: "" }) },
    });
    await waitForCondition(() => captured.signal !== undefined && cancel !== undefined, 1000);
    expect(captured.signal).toBeDefined();
    await cancel?.();
    const err = await rejectionOf(turn);

    expect(err.name).toBe("AbortError");
    expect(err.message).toBe("turn cancelled by its active-call cancel (idle watchdog or soft cancel)");
  });
});
