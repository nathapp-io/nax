/**
 * US-002 — wrapExternalHandler(): bounded lifetime, context and attributed
 * failure for plugin loop handlers.
 *
 * `src/hooks/` shells out with a 5s timeout and cannot return a patch. A plugin
 * loop handler is IN-PROCESS, so nothing bounds it and nothing catches it: a
 * handler that never settles would hang a turn, and a handler that throws must
 * not be able to silently pass a tool guard. This file drives the wrapper
 * directly — through the same `HandlerOf<E>` shape the dispatcher calls —
 * because that is the contract US-003 installs and US-004 delivers.
 *
 * Every test invokes the module at runtime and asserts its observable result;
 * the AC id is the test-name prefix.
 */

import { afterEach, describe, expect, type Mock, test } from "bun:test";
import { assertDefined, withDebugSpy, withTimerSpy, withWarnSpy } from "@test/helpers";
import { createLoopEventRegistry, type LoopEventRegistry } from "@/agents/native/session/loop-events";
import {
  _externalHandlerDeps,
  LOOP_HANDLER_TIMEOUT_MS,
  wrapExternalHandler,
} from "@/agents/native/session/loop-events/external-handler";
import type {
  AfterToolPayload,
  BeforeToolOutcome,
  BeforeToolPayload,
  BeforeTurnEndPayload,
  BeforeTurnPayload,
  LoopEvent,
  LoopHandlerContext,
  LoopHandlerEntry,
} from "@/agents/native/session/loop-events/types";
import type { Logger } from "@/logger";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PLUGIN = "gate-plugin";
/** The single-letter plugin name the acceptance criteria spell out. */
const SHORT_PLUGIN = "p";

const CALL = { id: "c1", name: "Edit", input: { path: "a.ts" } } as const;

const CTX: LoopHandlerContext = { sessionName: "session-1", role: "implementer" };

/** The timeout shortened by the tests that exercise the timer; restored after each. */
const ORIGINAL_TIMEOUT_MS = _externalHandlerDeps.timeoutMs;

afterEach(() => {
  _externalHandlerDeps.timeoutMs = ORIGINAL_TIMEOUT_MS;
});

const getCtx = (): LoopHandlerContext => CTX;

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function beforeToolPayload(toolName: string = CALL.name): BeforeToolPayload {
  return { call: { ...CALL, name: toolName }, tools: [] };
}

function afterToolPayload(): AfterToolPayload {
  return { content: "tool output", toolName: "Edit", callId: "c1" };
}

function beforeTurnPayload(): BeforeTurnPayload {
  return { prompt: "do the thing", history: [], sessionName: CTX.sessionName, boundary: false };
}

function beforeTurnEndPayload(): BeforeTurnEndPayload {
  return { messages: [], roundTrips: 1, ended: "completed", stopped: false, followUpsSoFar: 0 };
}

/** One staged plugin registration, exactly as `PluginRegistry.getLoopHandlers()` hands it over. */
function entryFor(plugin: string, event: LoopEvent, handler: LoopHandlerEntry["handler"]): LoopHandlerEntry {
  return { plugin, event, handler };
}

/**
 * Every `native-loop-events` warn record the spy captured, in call order — one
 * entry per logger.warn call, so a length assertion counts records.
 */
function loopEventWarnings(spy: Mock<Logger["warn"]>): Array<Record<string, unknown>> {
  return spy.mock.calls.filter((call) => call[0] === "native-loop-events").map((call) => call[2] ?? {});
}

/**
 * A staged entry whose handler settles a value its event's patch type forbids —
 * the shape a plugin module (plain JavaScript, untyped) can always produce, and
 * the one thing the wrapper must not be defeated by.
 *
 * `Object.assign` is how that value is staged without a cast: it is typed
 * `LoopHandlerEntry & { handler: () => unknown }`, so the staged entry still
 * satisfies `LoopHandlerEntry` for the wrapper's signature, while at runtime the
 * source's function is the one the wrapper calls.
 */
function entryReturning(plugin: string, event: LoopEvent, outcome: unknown): LoopHandlerEntry {
  const staged = entryFor(plugin, event, () => undefined);
  return Object.assign(staged, { handler: () => outcome });
}

/**
 * Register a handler the typed registrar cannot express — a built-in (or a
 * plugin, at runtime) answering something other than its event's patch type.
 * `Reflect.apply` is how such a value reaches the registry without a cast: its
 * argument list is `ArrayLike<unknown>` on purpose, so the value is staged at
 * runtime while the call itself stays checkable. The same device is already used
 * in test/unit/plugins/registry-loop-handlers.test.ts for an out-of-vocabulary
 * event name.
 */
function registerRaw(registry: LoopEventRegistry, event: LoopEvent, handler: () => unknown): void {
  Reflect.apply(registry.register, registry, [event, handler]);
}

/** The block outcome every `before_tool` failure resolves to, attributed to its plugin. */
function attributedBlock(plugin: string) {
  return expect.objectContaining({ kind: "block", content: expect.stringContaining(`'${plugin}'`) });
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — the timeout seam
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — the timeout seam", () => {
  test("AC1: LOOP_HANDLER_TIMEOUT_MS is 10000 and is the default _externalHandlerDeps.timeoutMs", () => {
    expect(LOOP_HANDLER_TIMEOUT_MS).toBe(10000);
    expect(_externalHandlerDeps.timeoutMs).toBe(LOOP_HANDLER_TIMEOUT_MS);
  });

  test("AC1 (boundary): the timeout is read when the handler is DISPATCHED, not when it is wrapped", async () => {
    // Shortened after the wrapper exists: a capture-at-wrap-time read would
    // still be 10_000 and this test would hang rather than assert.
    const entry = entryFor(PLUGIN, "before_tool", () => new Promise<never>(() => {}));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());
    _externalHandlerDeps.timeoutMs = 20;

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — payload and context
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — payload and context", () => {
  test("AC2: calls entry.handler with the dispatched payload and the value getCtx() returns at dispatch time", async () => {
    const received: Array<{ payload: unknown; ctx: LoopHandlerContext }> = [];
    const entry = entryFor(PLUGIN, "before_tool", (payload, ctx) => {
      received.push({ payload, ctx });
      return { kind: "allow" };
    });
    let ctx: LoopHandlerContext = { sessionName: "before-dispatch" };
    const wrapped = wrapExternalHandler(entry, () => ctx, freshSignal());
    const payload = beforeToolPayload();
    ctx = { sessionName: "at-dispatch" };

    await wrapped(payload);

    expect(received).toHaveLength(1);
    const first = received[0];
    assertDefined(first, "the handler call");
    expect(first.payload).toBe(payload);
    expect(first.ctx).toEqual({ sessionName: "at-dispatch" });
  });

  test("AC2 (boundary): a second dispatch reads getCtx() again instead of reusing the first context", async () => {
    const seen: Array<string> = [];
    const entry = entryFor(PLUGIN, "before_tool", (_payload, ctx) => {
      seen.push(ctx.sessionName);
      return { kind: "allow" };
    });
    let ctx: LoopHandlerContext = { sessionName: "dispatch-1" };
    const wrapped = wrapExternalHandler(entry, () => ctx, freshSignal());

    await wrapped(beforeToolPayload());
    ctx = { sessionName: "dispatch-2" };
    await wrapped(beforeToolPayload());

    expect(seen).toEqual(["dispatch-1", "dispatch-2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3–AC5 — settled values
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — settled values", () => {
  test("AC3: an after_tool handler that returns undefined settles to {}", async () => {
    const entry = entryFor(PLUGIN, "after_tool", () => undefined);
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(afterToolPayload())).toEqual({});
  });

  test("AC3 (boundary): a settled undefined outside before_tool is not a failure — nothing is logged", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(PLUGIN, "after_tool", () => undefined);
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      await wrapped(afterToolPayload());

      expect(loopEventWarnings(warnSpy)).toHaveLength(0);
    });
  });

  test("AC4: a before_tool handler that returns undefined settles to { kind: 'allow' }", async () => {
    const entry = entryFor(PLUGIN, "before_tool", () => undefined);
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual({ kind: "allow" });
  });

  test("AC4 (boundary): a settled undefined on before_tool is a no-op answer, not a failure", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(PLUGIN, "before_tool", () => undefined);
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      const outcome = await wrapped(beforeToolPayload());

      expect(outcome).toEqual({ kind: "allow" });
      expect(loopEventWarnings(warnSpy)).toHaveLength(0);
    });
  });

  test("AC5: a before_tool handler's own block outcome is resolved unchanged", async () => {
    const entry = entryFor(PLUGIN, "before_tool", () => ({ kind: "block", content: "no", isError: true }));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual({ kind: "block", content: "no", isError: true });
  });

  test("AC5 (boundary): another valid outcome — a nudge — keeps its text and input", async () => {
    const entry = entryFor(PLUGIN, "before_tool", () => ({
      kind: "nudge",
      text: "say it once",
      input: { path: "b.ts" },
    }));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual({ kind: "nudge", text: "say it once", input: { path: "b.ts" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6–AC10 — every failure shape on before_tool
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — before_tool failures block", () => {
  test("AC6: a throwing handler from plugin p resolves to an attributed block", async () => {
    const entry = entryFor(SHORT_PLUGIN, "before_tool", () => {
      throw new Error("boom");
    });
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual({
      kind: "block",
      isError: true,
      content: expect.stringMatching(/^Blocked: loop handler from plugin 'p' failed \(.*boom.*\)/),
    });
  });

  test("AC7: a handler whose promise rejects resolves to a block naming the plugin", async () => {
    const entry = entryFor(PLUGIN, "before_tool", () => Promise.reject(new Error("nope")));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC7 (boundary): a rejection with a non-Error reason is still a failure", async () => {
    // A plugin need not reject with an Error; extracting a message from a
    // string reason must not itself throw.
    const entry = entryFor(PLUGIN, "before_tool", () => Promise.reject("plain string reason"));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC8: a handler that never settles is cut off and resolves to a block naming the plugin", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    const entry = entryFor(PLUGIN, "before_tool", () => new Promise<never>(() => {}));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC8 (boundary): a handler that settles before the shortened timeout still wins", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    const entry = entryFor(PLUGIN, "before_tool", () => ({ kind: "allow" }));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual({ kind: "allow" });
  });

  test("AC9: a handler that resolves the string 'allow' is a failure", async () => {
    const entry = entryReturning(PLUGIN, "before_tool", "allow");
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC9 (boundary): an array is object-shaped but carries no kind — a failure, not an allow", async () => {
    const entry = entryReturning(PLUGIN, "before_tool", ["allow"]);
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC10: a handler that resolves { kind: 'maybe' } is a failure", async () => {
    const entry = entryReturning(PLUGIN, "before_tool", { kind: "maybe" });
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC10 (boundary): a null return is a failure, not a pass-through", async () => {
    const entry = entryReturning(PLUGIN, "before_tool", null);
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC10 (boundary): a block with no content is incomplete, not a block", async () => {
    const entry = entryReturning(PLUGIN, "before_tool", { kind: "block" });
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    // A plugin can be plain JavaScript; a `kind` without the `content` the
    // transcript builder records would put `undefined` in the tool result.
    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });

  test("AC10 (boundary): a nudge with no text is incomplete, not an allow", async () => {
    const entry = entryReturning(PLUGIN, "before_tool", { kind: "nudge" });
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    // A textless nudge would otherwise be silently downgraded to `allow`.
    expect(await wrapped(beforeToolPayload())).toEqual(attributedBlock(PLUGIN));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11–AC13 — attributed failure logs
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — attributed failure logs", () => {
  test("AC11: a blocked before_tool failure logs one warning naming plugin, event, tool and error", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(PLUGIN, "before_tool", () => {
        throw new Error("boom goes the handler");
      });
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      await wrapped(beforeToolPayload("Edit"));

      const warnings = loopEventWarnings(warnSpy);
      expect(warnings).toHaveLength(1);
      const record = warnings[0];
      assertDefined(record, "the warn record");
      expect(record.plugin).toBe(PLUGIN);
      expect(record.event).toBe("before_tool");
      expect(record.tool).toBe("Edit");
      expect(String(record.error)).toContain("boom goes the handler");
    });
  });

  test("AC11 (boundary): the recorded tool is the name of the dispatched call, not a constant", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(PLUGIN, "before_tool", () => {
        throw new Error("boom");
      });
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      await wrapped(beforeToolPayload("Write"));

      const record = loopEventWarnings(warnSpy)[0];
      assertDefined(record, "the warn record");
      expect(record.tool).toBe("Write");
    });
  });

  test("AC12: a throwing after_tool handler resolves to {} and logs one warning with plugin and event", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(SHORT_PLUGIN, "after_tool", () => {
        throw new Error("tool handler died");
      });
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      const outcome = await wrapped(afterToolPayload());

      expect(outcome).toEqual({});
      const warnings = loopEventWarnings(warnSpy);
      expect(warnings).toHaveLength(1);
      const record = warnings[0];
      assertDefined(record, "the warn record");
      expect(record.plugin).toBe(SHORT_PLUGIN);
      expect(record.event).toBe("after_tool");
    });
  });

  test("AC12 (boundary): a rejecting after_tool handler behaves exactly like a throwing one", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(SHORT_PLUGIN, "after_tool", () => Promise.reject(new Error("tool handler died")));
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      const outcome = await wrapped(afterToolPayload());

      expect(outcome).toEqual({});
      expect(loopEventWarnings(warnSpy)).toHaveLength(1);
    });
  });

  test("AC13: a before_turn_end handler that never settles resolves to {} and warns naming the plugin", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(PLUGIN, "before_turn_end", () => new Promise<never>(() => {}));
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      const outcome = await wrapped(beforeTurnEndPayload());

      expect(outcome).toEqual({});
      const warnings = loopEventWarnings(warnSpy);
      expect(warnings).toHaveLength(1);
      const record = warnings[0];
      assertDefined(record, "the warn record");
      expect(record.plugin).toBe(PLUGIN);
    });
  });

  test("AC13 (boundary): a throwing before_turn handler answers {} — only before_tool blocks", async () => {
    await withWarnSpy(async (warnSpy) => {
      const entry = entryFor(PLUGIN, "before_turn", () => {
        throw new Error("turn handler died");
      });
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      const outcome = await wrapped(beforeTurnPayload());

      expect(outcome).toEqual({});
      expect(loopEventWarnings(warnSpy)).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14–AC16 — the race, the timer and the signal
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — race, timer and signal", () => {
  test("AC14: aborting the signal resolves a never-settling before_tool handler before the timeout elapses", async () => {
    const timeoutMs = 500;
    _externalHandlerDeps.timeoutMs = timeoutMs;
    const controller = new AbortController();
    const entry = entryFor(PLUGIN, "before_tool", () => new Promise<never>(() => {}));
    const wrapped = wrapExternalHandler(entry, getCtx, controller.signal);

    const startedAt = Date.now();
    const pending = wrapped(beforeToolPayload());
    // One microtask so the wrapper has entered its race before the abort — the
    // AC is about the abort winning that race, not about when its listener is wired.
    await Promise.resolve();
    controller.abort();
    const outcome = await pending;
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toEqual(attributedBlock(PLUGIN));
    expect(elapsedMs).toBeLessThan(timeoutMs);
  });

  test("AC14 (boundary): aborting after the handler settled leaves the settled outcome alone", async () => {
    const controller = new AbortController();
    const entry = entryFor(PLUGIN, "before_tool", () => ({ kind: "allow" }));
    const wrapped = wrapExternalHandler(entry, getCtx, controller.signal);

    const outcome = await wrapped(beforeToolPayload());
    controller.abort();

    expect(outcome).toEqual({ kind: "allow" });
  });

  test("AC15: a handler that resolves allow only after the timeout fired yields the timeout block", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    let releaseLate: ((outcome: BeforeToolOutcome) => void) | undefined;
    const late = new Promise<BeforeToolOutcome>((resolve) => {
      releaseLate = resolve;
    });
    const entry = entryFor(PLUGIN, "before_tool", () => late);
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    // Settles on the timeout: the handler has NOT settled at this point.
    const outcome = await wrapped(beforeToolPayload());
    assertDefined(releaseLate, "the late resolver");
    releaseLate({ kind: "allow" });
    await Promise.resolve();

    expect(outcome).toEqual(attributedBlock(PLUGIN));
  });

  test("AC15 (boundary): a late rejection after the timeout block is discarded, not surfaced", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    let rejectLate: ((err: Error) => void) | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });
    const entry = entryFor(PLUGIN, "before_tool", () => late);
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    const outcome = await wrapped(beforeToolPayload());
    assertDefined(rejectLate, "the late rejecter");
    rejectLate(new Error("too late"));
    await Promise.resolve();

    expect(outcome).toEqual(attributedBlock(PLUGIN));
  });

  test("AC16: the timeout timer armed for a handler that settles immediately has been cleared", async () => {
    // 20ms so a leaked timer expires quickly instead of holding the runner.
    _externalHandlerDeps.timeoutMs = 20;
    const entry = entryFor(PLUGIN, "before_tool", () => ({ kind: "allow" }));
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    const { result, leaked } = await withTimerSpy(async () => wrapped(beforeToolPayload()));

    expect(result).toEqual({ kind: "allow" });
    // An armed-but-never-cleared timeout holds Bun's event loop for its full
    // duration; `leaked` is the handle the wrapper failed to clear.
    expect(leaked).toHaveLength(0);
  });

  test("AC16 (boundary): the failure path clears the timer too", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    const entry = entryFor(PLUGIN, "before_tool", () => {
      throw new Error("boom");
    });
    const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

    const { result, leaked } = await withTimerSpy(async () => wrapped(beforeToolPayload()));

    expect(result).toEqual(attributedBlock(PLUGIN));
    expect(leaked).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC17 — traceable patches
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — traceable patches", () => {
  test("AC17: a before_turn patch carrying seed is returned and traced at debug with plugin, event and fields", async () => {
    await withDebugSpy(async (debugSpy) => {
      const seed: BeforeTurnPayload["history"] = [{ role: "user", content: "seeded" }];
      const entry = entryFor(SHORT_PLUGIN, "before_turn", () => ({ seed }));
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      const outcome = await wrapped(beforeTurnPayload());

      expect(outcome).toEqual({ seed });
      const traces = debugSpy.mock.calls.filter((call) => call[0] === "native-loop-events");
      expect(traces).toHaveLength(1);
      const record = traces[0]?.[2];
      assertDefined(record, "the debug record");
      expect(record.plugin).toBe(SHORT_PLUGIN);
      expect(record.event).toBe("before_turn");
      expect(record.fields).toEqual(["seed"]);
    });
  });

  test("AC17 (boundary): an empty patch traces no field", async () => {
    await withDebugSpy(async (debugSpy) => {
      const entry = entryFor(SHORT_PLUGIN, "before_turn", () => undefined);
      const wrapped = wrapExternalHandler(entry, getCtx, freshSignal());

      expect(await wrapped(beforeTurnPayload())).toEqual({});

      // Nothing reached a history field, so no record may claim one — the trace
      // exists to make a later applyHistoryPatch rejection attributable.
      const tracedFields = debugSpy.mock.calls
        .filter((call) => call[0] === "native-loop-events")
        .map((call) => call[2]?.fields)
        .filter((fields) => Array.isArray(fields) && fields.length > 0);
      expect(tracedFields).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC18–AC19 — through the dispatcher
// ─────────────────────────────────────────────────────────────────────────────

describe("external handler wrapper — through the loop-event dispatcher", () => {
  test("AC18: a wrapped throwing plugin handler logs exactly one warning for one dispatch", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = createLoopEventRegistry();
      const entry = entryFor(PLUGIN, "before_tool", () => {
        throw new Error("gate exploded");
      });
      registry.register(entry.event, wrapExternalHandler(entry, getCtx, freshSignal()));

      const outcome = await registry.dispatch("before_tool", beforeToolPayload());

      // The wrapper never rethrows, so the dispatcher's own "handler threw"
      // warning must not fire on top of the wrapper's attributed one.
      expect(loopEventWarnings(warnSpy)).toHaveLength(1);
      expect(outcome).toEqual(attributedBlock(PLUGIN));
    });
  });

  test("AC18 (boundary): a second dispatch adds its own single warning", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = createLoopEventRegistry();
      const entry = entryFor(PLUGIN, "before_tool", () => {
        throw new Error("gate exploded");
      });
      registry.register(entry.event, wrapExternalHandler(entry, getCtx, freshSignal()));

      await registry.dispatch("before_tool", beforeToolPayload());
      await registry.dispatch("before_tool", beforeToolPayload());

      expect(loopEventWarnings(warnSpy)).toHaveLength(2);
    });
  });

  test("AC19: dispatch resolves a built-in before_tool outcome with no kind to { kind: 'allow' } and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = createLoopEventRegistry();
      registerRaw(registry, "before_tool", () => undefined);

      // The AC is "resolves instead of throwing": a rejection is converted into
      // the assertion below rather than aborting the test body.
      const outcome = await registry.dispatch("before_tool", beforeToolPayload()).then(
        (value) => value,
        () => undefined,
      );

      expect(outcome).toEqual({ kind: "allow" });
      expect(loopEventWarnings(warnSpy)).toHaveLength(1);
    });
  });

  test("AC19 (boundary): a built-in outcome that is not an object at all is an allow too", async () => {
    await withWarnSpy(async (warnSpy) => {
      const registry = createLoopEventRegistry();
      registerRaw(registry, "before_tool", () => null);

      const outcome = await registry.dispatch("before_tool", beforeToolPayload()).then(
        (value) => value,
        () => undefined,
      );

      expect(outcome).toEqual({ kind: "allow" });
      expect(loopEventWarnings(warnSpy)).toHaveLength(1);
    });
  });
});
