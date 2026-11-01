/**
 * US-001 — per-entry deadlines for plugin loop handlers.
 *
 * `LoopHandlerEntry.timeoutMs` lets ONE handler widen its own deadline without
 * widening every other one: a formatter or type check after an edit routinely
 * needs longer than the 10 s default, and a plugin handler that does not set it
 * keeps that default.
 *
 * Only a FINITE POSITIVE `timeoutMs` replaces the default — `0` and `Infinity`
 * are not deadlines, so they must not turn the bound off or fire it instantly.
 *
 * The deadline is driven on a `makeFakeClock()` through
 * `_externalHandlerDeps.setTimeout`/`clearTimeout` instead of being slept for:
 * `docs/guides/testing-rules.md` §3 forbids a fixed sleep in a test, and "wait
 * a real 100 ms and hope the 20 ms default lost the race" is exactly the flake
 * it forbids. Every assertion below is therefore exact rather than bounded.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { _externalHandlerDeps, wrapExternalHandler } from "#src/native/session/loop-events/index";
import type {
  BeforeToolOutcome,
  BeforeToolPayload,
  BeforeTurnPayload,
  LoopEvent,
  LoopHandlerContext,
  LoopHandlerEntry,
} from "#src/native/session/loop-events/types";
import { type FakeClock, makeFakeClock } from "#test/helpers/index";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PLUGIN = "formatter-plugin";

const CTX: LoopHandlerContext = { sessionName: "session-1", role: "implementer" };

const getCtx = (): LoopHandlerContext => CTX;

function freshSignal(): AbortSignal {
  return new AbortController().signal;
}

function beforeToolPayload(): BeforeToolPayload {
  return { call: { id: "c1", name: "Edit", input: { path: "a.ts" } }, tools: [] };
}

function beforeTurnPayload(): BeforeTurnPayload {
  return { prompt: "do the thing", history: [], sessionName: CTX.sessionName, boundary: false };
}

/** One staged plugin registration, as `PluginRegistry.getLoopHandlers()` hands it over. */
function entryFor(event: LoopEvent, handler: LoopHandlerEntry["handler"], timeoutMs?: number): LoopHandlerEntry {
  return { plugin: PLUGIN, event, handler, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

/** The block outcome every `before_tool` failure resolves to, attributed to its plugin. */
function attributedBlock(reason: string) {
  return { kind: "block", isError: true, content: expect.stringContaining(`'${PLUGIN}' failed (${reason})`) };
}

// ── the deadline timer, pointed at a virtual clock ──────────────────────────

const REAL_TIMEOUT_MS = _externalHandlerDeps.timeoutMs;
const REAL_SET_TIMEOUT = _externalHandlerDeps.setTimeout;
const REAL_CLEAR_TIMEOUT = _externalHandlerDeps.clearTimeout;

afterEach(() => {
  _externalHandlerDeps.timeoutMs = REAL_TIMEOUT_MS;
  _externalHandlerDeps.setTimeout = REAL_SET_TIMEOUT;
  _externalHandlerDeps.clearTimeout = REAL_CLEAR_TIMEOUT;
});

/** Arms the wrapper's deadline on `clock` instead of on the real event loop. */
function useClock(clock: FakeClock): void {
  _externalHandlerDeps.setTimeout = clock.setTimeout;
  _externalHandlerDeps.clearTimeout = clock.clearTimeout;
}

interface Watched {
  readonly pending: Promise<unknown>;
  settled(): boolean;
  outcome(): unknown;
  /** Virtual time the wrapper answered at; undefined while it is still pending. */
  answeredAtMs(): number | undefined;
}

/**
 * Starts one dispatch and records what it answered, and WHEN on `clock`.
 *
 * The readers are methods rather than fields because the answer arrives on a
 * microtask AFTER the clock advanced: a snapshot would always read "unsettled".
 */
function watch(run: () => unknown, clock: FakeClock): Watched {
  const state: { settled: boolean; outcome: unknown; answeredAtMs?: number } = {
    settled: false,
    outcome: undefined,
  };
  // A `HandlerOf` may answer synchronously; `Promise.resolve` gives the watcher
  // one shape to observe either way.
  const pending = Promise.resolve(run());
  void pending.then((outcome: unknown) => {
    state.outcome = outcome;
    state.settled = true;
    state.answeredAtMs = clock.now();
  });
  return {
    pending,
    settled: () => state.settled,
    outcome: () => state.outcome,
    answeredAtMs: () => state.answeredAtMs,
  };
}

/** The handler that never settles — the shape the deadline exists for. */
const neverSettles = (): Promise<never> => new Promise<never>(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10 to AC-13 — which deadline a dispatch is bounded by
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapExternalHandler — the entry's own deadline", () => {
  test("AC-10: timeoutMs 50 cuts a never-settling before_tool handler off at 50 ms, not at the 10 s default", async () => {
    _externalHandlerDeps.timeoutMs = 10000;
    const clock = makeFakeClock();
    useClock(clock);
    const entry = entryFor("before_tool", neverSettles, 50);
    const wrapped = wrapExternalHandler<"before_tool">(entry, getCtx, freshSignal());

    const startedAtMs = clock.now();
    const seen = watch(() => wrapped(beforeToolPayload()), clock);

    await clock.advance(49);
    // The 10 s default is still 9.951 s away, so nothing may have answered yet:
    // a dispatch that fired here was bounded by neither number.
    expect(seen.settled()).toBe(false);

    await clock.advance(1);

    expect(seen.outcome()).toEqual(attributedBlock("did not settle within 50ms"));
    expect(seen.answeredAtMs()).toBe(startedAtMs + 50);
  });

  test("AC-11: a 5000 ms entry deadline replaces a 20 ms default for a handler that settles at 100 ms", async () => {
    _externalHandlerDeps.timeoutMs = 20;
    const clock = makeFakeClock();
    useClock(clock);
    const handler = (): Promise<BeforeToolOutcome> =>
      new Promise<BeforeToolOutcome>((resolve) => {
        // Settles at virtual +100 ms: past the 20 ms default, short of 5000 ms.
        clock.setTimeout(() => resolve({ kind: "allow" }), 100);
      });
    const entry = entryFor("before_tool", handler, 5000);
    const wrapped = wrapExternalHandler<"before_tool">(entry, getCtx, freshSignal());

    const pending = wrapped(beforeToolPayload());
    // Two timers on the virtual clock: the entry's 5000 ms deadline and the
    // handler's own settle timer. One means the deadline went somewhere else —
    // the 20 ms default on the real clock, which is what this AC rules out.
    expect(clock.pending()).toBe(2);
    await clock.advance(100);

    // Under the 20 ms default this answers a block at 20 ms instead of the allow.
    expect(await pending).toEqual({ kind: "allow" });
  });

  test("AC-12: an entry with no timeoutMs keeps the module deadline — 30 ms here", async () => {
    _externalHandlerDeps.timeoutMs = 30;
    const clock = makeFakeClock();
    useClock(clock);
    const entry = entryFor("before_tool", neverSettles);
    const wrapped = wrapExternalHandler<"before_tool">(entry, getCtx, freshSignal());

    const startedAtMs = clock.now();
    const seen = watch(() => wrapped(beforeToolPayload()), clock);

    await clock.advance(29);
    expect(seen.settled()).toBe(false);
    await clock.advance(1);

    expect(seen.outcome()).toEqual(attributedBlock("did not settle within 30ms"));
    expect(seen.answeredAtMs()).toBe(startedAtMs + 30);
  });

  test.each([
    ["0", 0],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("AC-13: timeoutMs %s is not a deadline — the 30 ms default applies", async (_label, timeoutMs) => {
    _externalHandlerDeps.timeoutMs = 30;
    const clock = makeFakeClock();
    useClock(clock);
    const entry = entryFor("before_tool", neverSettles, timeoutMs);
    const wrapped = wrapExternalHandler<"before_tool">(entry, getCtx, freshSignal());

    const startedAtMs = clock.now();
    const seen = watch(() => wrapped(beforeToolPayload()), clock);

    await clock.advance(29);
    // Neither an instant fire (0) nor no fire at all (Infinity).
    expect(seen.settled()).toBe(false);
    await clock.advance(1);

    expect(seen.outcome()).toEqual(attributedBlock("did not settle within 30ms"));
    expect(seen.answeredAtMs()).toBe(startedAtMs + 30);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14 — a missed deadline outside before_tool changes nothing
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapExternalHandler — a missed deadline outside before_tool", () => {
  test("AC-14: a before_turn handler that misses its timeoutMs answers an empty patch", async () => {
    _externalHandlerDeps.timeoutMs = 10000;
    const clock = makeFakeClock();
    useClock(clock);
    const entry = entryFor("before_turn", neverSettles, 20);
    const wrapped = wrapExternalHandler<"before_turn">(entry, getCtx, freshSignal());

    const startedAtMs = clock.now();
    const seen = watch(() => wrapped(beforeTurnPayload()), clock);
    // One timer armed, and on the virtual clock: a deadline still on the real
    // event loop would leave this at zero and answer 20 ms of wall clock later.
    expect(clock.pending()).toBe(1);

    await clock.advance(20);

    // The wrapper's failure rule for every event but before_tool: the event is
    // left unchanged, so a hook that never answers cannot rewrite a turn.
    expect(seen.outcome()).toEqual({});
    expect(seen.answeredAtMs()).toBe(startedAtMs + 20);
  });
});
