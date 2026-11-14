/**
 * US-003: a provider tool's cancel grace in the facade's InteractionHandler.
 * Split from session-interaction.test.ts by concern: every case here runs on a
 * fake clock injected as `SessionInteractionDeps.timers`, so the tool's own
 * settlement and the grace itself are both virtual and no case waits on wall
 * time.
 */
import { describe, expect, test } from "bun:test";
import { NaxError } from "#src/infra/nax-error";
import type { AdapterInteraction, InteractionHandler } from "#src/session/interaction-handler";
import { createPendingAskTable } from "#src/session/pending-asks";
import { createSessionAskPort } from "#src/session/session-ask-port";
import {
  createSessionInteractionHandler,
  MAX_CANCEL_GRACE_MS,
  type SessionInteractionDeps,
} from "#src/session/session-interaction";
import type { CodingToolOutcome, CodingToolRuntime, ToolCallContext } from "#src/tools/runtime";
import { type FakeClock, makeFakeClock } from "#test/helpers/index";

function codingTool(
  name: string,
  input: Record<string, unknown> = {},
): Extract<AdapterInteraction, { kind: "coding-tool" }> {
  return {
    kind: "coding-tool",
    name,
    input,
    toolCallId: "call-1",
    turnId: "turn-1",
    roundTrips: 2,
    deferModelTruncation: true,
  };
}

async function thrown(promise: Promise<unknown>): Promise<NaxError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof NaxError) return err;
    throw err;
  }
  throw new Error("expected a NaxError");
}

/**
 * US-003: a provider tool's cancel grace. Every case here runs on a fake clock
 * injected as `SessionInteractionDeps.timers`; the tool's own settlement is
 * scheduled on that same clock, so nothing waits on wall time.
 */

const IDLE = new AbortController().signal;
const PUT_GRACE_MS = 500;
const ABANDONED_PUT = 'Tool "acme__put" was abandoned: the turn ended.';

interface GraceHarness {
  readonly handler: InteractionHandler;
  readonly calls: () => number;
}

/** A handler whose timers — the grace and any tool settlement — are all virtual. */
function graceHarness(options: {
  readonly clock: FakeClock;
  readonly graceByTool?: ReadonlyMap<string, number>;
  readonly callTool?: (context: ToolCallContext | undefined) => Promise<CodingToolOutcome>;
}): GraceHarness {
  let calls = 0;
  const runtime: CodingToolRuntime = {
    advertised: () => [],
    callTool(_name, _input, context) {
      calls += 1;
      return options.callTool?.(context) ?? new Promise<CodingToolOutcome>(() => {});
    },
  };
  const deps: SessionInteractionDeps = {
    sessionId: "s1",
    runtime,
    embedderTools: new Map(),
    asks: createSessionAskPort({
      table: createPendingAskTable(30_000),
      emit: () => {},
      turn: () => undefined,
    }),
    turnSignal: () => IDLE,
    setCurrentCallId: () => {},
    ...(options.graceByTool !== undefined ? { cancelGraceByTool: options.graceByTool } : {}),
    timers: {
      setTimeout: (fn, ms) => options.clock.setTimeout(fn, ms),
      clearTimeout: (id) => {
        if (typeof id === "number") options.clock.clearTimeout(id);
      },
    },
  };
  return { handler: createSessionInteractionHandler(deps), calls: () => calls };
}

/**
 * A callTool that resolves with `outcome` `ms` AFTER its signal aborts — the
 * shape a provider tool takes when it answers its own cancellation.
 */
function settlesAfterAbort(
  clock: FakeClock,
  outcome: CodingToolOutcome,
  ms: number,
): (context: ToolCallContext | undefined) => Promise<CodingToolOutcome> {
  return (context) =>
    new Promise<CodingToolOutcome>((resolve) => {
      const settle = (): void => {
        clock.setTimeout(() => resolve(outcome), ms);
      };
      const signal = context?.signal;
      if (signal === undefined) return;
      if (signal.aborted) settle();
      else signal.addEventListener("abort", settle, { once: true });
    });
}

/** A callTool that rejects with `error` `ms` after its signal aborts. */
function rejectsAfterAbort(
  clock: FakeClock,
  error: Error,
  ms: number,
): (context: ToolCallContext | undefined) => Promise<CodingToolOutcome> {
  return (context) =>
    new Promise<CodingToolOutcome>((_resolve, reject) => {
      const settle = (): void => {
        clock.setTimeout(() => reject(error), ms);
      };
      const signal = context?.signal;
      if (signal === undefined) return;
      if (signal.aborted) settle();
      else signal.addEventListener("abort", settle, { once: true });
    });
}

/** A request whose signal the test aborts mid-call. */
function graceRequest(name: string): { readonly controller: AbortController; readonly request: AdapterInteraction } {
  const controller = new AbortController();
  return { controller, request: { ...codingTool(name), signal: controller.signal } };
}

/** Whether `pending` has settled yet, without consuming its value or rejection. */
function trackSettlement(pending: Promise<unknown>): { readonly done: () => boolean } {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return { done: () => settled };
}

const putGrace = (): ReadonlyMap<string, number> => new Map([["acme__put", PUT_GRACE_MS]]);

describe("createSessionInteractionHandler cancel grace (US-003)", () => {
  test("AC-3: MAX_CANCEL_GRACE_MS is 10 seconds", () => {
    expect(MAX_CANCEL_GRACE_MS).toBe(10_000);
  });

  test("AC-4: the tool's own ok outcome inside the grace is the answer", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({
      clock,
      graceByTool: putGrace(),
      callTool: settlesAfterAbort(clock, { kind: "ok", content: "done" }, 50),
    });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    await clock.advance(50);
    expect(await pending).toEqual({ answer: "done" });
    expect(h.calls()).toBe(1);
  });

  test("AC-5: an error outcome inside the grace throws its content", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({
      clock,
      graceByTool: putGrace(),
      callTool: settlesAfterAbort(clock, { kind: "error", content: "[chat] nothing was pushed" }, 50),
    });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    await clock.advance(50);
    expect((await thrown(pending)).message).toBe("[chat] nothing was pushed");
  });

  test("AC-6: a denied outcome inside the grace answers the denial", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({
      clock,
      graceByTool: putGrace(),
      callTool: settlesAfterAbort(clock, { kind: "denied", reason: "no", breach: false }, 50),
    });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    await clock.advance(50);
    expect(await pending).toEqual({ answer: "Denied: no", denied: { reason: "no", breach: false } });
  });

  test("AC-7/AC-13: an outcome past the grace is abandoned at the grace, on a clock and fast", async () => {
    const startedAt = performance.now();
    const clock = makeFakeClock();
    const h = graceHarness({
      clock,
      graceByTool: putGrace(),
      callTool: settlesAfterAbort(clock, { kind: "ok", content: "late" }, 1_000),
    });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    const settlement = trackSettlement(pending);
    controller.abort();
    await clock.advance(PUT_GRACE_MS - 1);
    expect(settlement.done()).toBe(false);
    await clock.advance(1);
    expect(settlement.done()).toBe(true);
    expect((await thrown(pending)).message).toBe(ABANDONED_PUT);
    // AC-13: the whole case is virtual, so it cannot have spent the 500 ms.
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  test("AC-8: a tool absent from the grace map is abandoned the moment the signal aborts", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({ clock, graceByTool: putGrace() });
    const { controller, request } = graceRequest("acme__get");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    expect((await thrown(pending)).message).toBe('Tool "acme__get" was abandoned: the turn ended.');
    expect(clock.pending()).toBe(0);
  });

  test("AC-9: a signal already aborted abandons the call without invoking the tool", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({ clock, graceByTool: putGrace() });
    const controller = new AbortController();
    controller.abort();
    const err = await thrown(h.handler.onInteraction({ ...codingTool("acme__put"), signal: controller.signal }));
    expect(err.message).toBe(ABANDONED_PUT);
    expect(h.calls()).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  test.each([Number.NaN, 0, -5])("AC-10: a grace of %p is no grace at all", async (grace) => {
    const clock = makeFakeClock();
    const h = graceHarness({ clock, graceByTool: new Map([["acme__put", grace]]) });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    expect((await thrown(pending)).message).toBe(ABANDONED_PUT);
    expect(clock.pending()).toBe(0);
  });

  test("AC-17: an infinite grace is no grace at all", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({ clock, graceByTool: new Map([["acme__put", Number.POSITIVE_INFINITY]]) });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    expect((await thrown(pending)).message).toBe(ABANDONED_PUT);
    expect(clock.pending()).toBe(0);
  });

  test("AC-11: a grace above the ceiling is clamped to MAX_CANCEL_GRACE_MS", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({ clock, graceByTool: new Map([["acme__put", 60_000]]) });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    const settlement = trackSettlement(pending);
    controller.abort();
    await clock.advance(MAX_CANCEL_GRACE_MS - 1);
    expect(settlement.done()).toBe(false);
    await clock.advance(1);
    expect(settlement.done()).toBe(true);
    expect((await thrown(pending)).message).toBe(ABANDONED_PUT);
  });

  test("AC-12: a grace-path answer leaves no timer armed", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({
      clock,
      graceByTool: putGrace(),
      callTool: settlesAfterAbort(clock, { kind: "ok", content: "done" }, 50),
    });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    await clock.advance(50);
    expect(await pending).toEqual({ answer: "done" });
    expect(clock.pending()).toBe(0);
  });

  test("AC-15: a rejection past the grace is observed, not left unhandled", async () => {
    const clock = makeFakeClock();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const h = graceHarness({
        clock,
        graceByTool: putGrace(),
        callTool: rejectsAfterAbort(clock, new Error("koda went away"), 1_000),
      });
      const { controller, request } = graceRequest("acme__put");
      const pending = h.handler.onInteraction(request);
      controller.abort();
      await clock.advance(PUT_GRACE_MS);
      expect((await thrown(pending)).message).toBe(ABANDONED_PUT);
      await clock.advance(1_000);
      // Let the runtime report any unhandled rejection before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("AC-18: a rejection inside the grace propagates as an unaborted call would", async () => {
    const clock = makeFakeClock();
    const h = graceHarness({
      clock,
      graceByTool: putGrace(),
      callTool: rejectsAfterAbort(clock, new Error("db down"), 50),
    });
    const { controller, request } = graceRequest("acme__put");
    const pending = h.handler.onInteraction(request);
    controller.abort();
    await clock.advance(50);
    // Not a NaxError: an unaborted call surfaces the tool's own rejection as-is.
    await expect(pending).rejects.toThrow("db down");
    expect(clock.pending()).toBe(0);
  });
});
