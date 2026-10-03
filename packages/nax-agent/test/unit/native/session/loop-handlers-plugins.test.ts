/**
 * US-003 — plugin loop handlers installed between the native turn built-ins.
 *
 * `turn-loop.ts` builds a fresh registry every turn and hands it to
 * `registerBuiltinLoopHandlers` together with the plugin set, so the installer
 * is the ONE place that decides where a plugin's entries sit relative to the
 * built-ins. These tests drive it directly — a real `createLoopEventRegistry()`,
 * installed, then dispatched — because the install POSITION is what every
 * criterion here observes:
 *
 *  - a plugin `before_tool` handler judges the call AFTER null-optional repair
 *    (AC1) and is never reached for a call a built-in already refused (AC4,
 *    AC5) — `dispatchBeforeTool` returns on the first block/terminate;
 *  - a plugin `after_tool` result is shaped by the truncation handler that
 *    registers LAST (AC2), and plugin entries chain in set order (AC3);
 *  - a second install for the same registry repoints the per-turn state
 *    instead of registering the entries again (AC6, AC7), and the per-turn
 *    signal reaches a wrapped plugin handler (AC8).
 *
 * Every test invokes the module at runtime and asserts an observable result;
 * the AC id is the test-name prefix.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSpinBreaker, DEFAULT_SPIN_BREAKER_SETTINGS, type SpinBreaker } from "#src/infra/spin-breaker/index";
import { createInvalidCallBudget } from "#src/native/session/handle-invalid-tool-call";
import { createLoopEventRegistry, type LoopEventRegistry } from "#src/native/session/loop-events/index";
import type {
  BeforeToolPayload,
  LoopEvent,
  LoopHandlerContext,
  LoopHandlerEntry,
  LoopHandlerSet,
} from "#src/native/session/loop-events/types";
import { registerBuiltinLoopHandlers } from "#src/native/session/loop-handlers";
import { createNativeSessionState, type NativeSessionState } from "#src/native/session/session";
import { MODEL_MAX_BYTES } from "#src/tools/index";
import { assertDefined, cleanupTempDir, makeTempDir, seedNativeSession, waitForCondition } from "#test/helpers/index";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SESSION = "sess-loop-handlers-plugins";
const CTX: LoopHandlerContext = { sessionName: SESSION, role: "implementer" };

let dir: string;
let sessionState: NativeSessionState;

beforeEach(() => {
  dir = makeTempDir("nax-loop-handlers-plugins-");
  sessionState = seedNativeSession(createNativeSessionState(), SESSION, { transcriptDir: dir });
});
afterEach(() => {
  cleanupTempDir(dir);
});

/**
 * A Read whose `limit` is optional, so a `null` for it reads as "not supplied"
 * to the validator — and must therefore be gone from the call a plugin
 * `before_tool` handler sees (AC1).
 */
const READ_TOOLS: BeforeToolPayload["tools"] = [
  {
    name: "Read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "number" } },
      required: ["path"],
    },
  },
];

function readCall(id: string, input: Record<string, unknown>): BeforeToolPayload {
  return { call: { id, name: "Read", input }, tools: READ_TOOLS };
}

function afterToolPayload(content: string) {
  return { content, toolName: "Read", callId: "c1" };
}

/** One staged registration, as `PluginRegistry.getLoopHandlers()` hands it over. */
function pluginEntry(event: LoopEvent, handler: LoopHandlerEntry["handler"], plugin = "p"): LoopHandlerEntry {
  return { plugin, event, handler };
}

/** The plugin set a caller would forward as `loopHandlers` for one turn. */
function handlerSet(...entries: readonly LoopHandlerEntry[]): LoopHandlerSet {
  return entries;
}

interface InstallOverrides {
  readonly loopHandlers?: LoopHandlerSet;
  readonly loopHandlerContext?: LoopHandlerContext;
  readonly signal?: AbortSignal;
  readonly spinBreaker?: SpinBreaker;
}

/** Install the built-ins AND whatever the turn supplied, as the loop does once per turn. */
function install(registry: LoopEventRegistry, over: InstallOverrides = {}): void {
  registerBuiltinLoopHandlers(registry, {
    sessionName: SESSION,
    sessionState,
    budget: createInvalidCallBudget(),
    ...(over.spinBreaker !== undefined ? { spinBreaker: over.spinBreaker } : {}),
    onSpinStop: () => {},
    ...(over.loopHandlers !== undefined ? { loopHandlers: over.loopHandlers } : {}),
    ...(over.loopHandlerContext !== undefined ? { loopHandlerContext: over.loopHandlerContext } : {}),
    ...(over.signal !== undefined ? { signal: over.signal } : {}),
  });
}

/** A plugin handler that records every call it is handed and answers nothing. */
function recordingBeforeToolHandler(seen: BeforeToolPayload["call"][]): LoopHandlerEntry["handler"] {
  return (payload) => {
    if ("call" in payload) seen.push(payload.call);
    return undefined;
  };
}

function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1–AC3 — install order
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — registerBuiltinLoopHandlers: install order", () => {
  test("AC1: a plugin before_tool handler is handed a call whose null optional property is gone", async () => {
    const registry = createLoopEventRegistry();
    const seen: BeforeToolPayload["call"][] = [];
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("before_tool", recordingBeforeToolHandler(seen))),
      loopHandlerContext: CTX,
    });

    await registry.dispatch("before_tool", readCall("c1", { path: "a.ts", limit: null }));

    expect(seen).toHaveLength(1);
    const call = seen[0];
    assertDefined(call, "the call the plugin handler was handed");
    // The built-in repair runs first, so the plugin judges the call the tool
    // would actually receive — not the model's `limit: null`.
    expect(call.input).not.toHaveProperty("limit");
    expect(call.input).toEqual({ path: "a.ts" });
  });

  test("AC1 (boundary): a supplied optional property is not stripped from the call the plugin sees", async () => {
    const registry = createLoopEventRegistry();
    const seen: BeforeToolPayload["call"][] = [];
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("before_tool", recordingBeforeToolHandler(seen))),
      loopHandlerContext: CTX,
    });

    await registry.dispatch("before_tool", readCall("c1", { path: "a.ts", limit: 5 }));

    expect(seen).toHaveLength(1);
    const call = seen[0];
    assertDefined(call, "the call the plugin handler was handed");
    expect(call.input).toEqual({ path: "a.ts", limit: 5 });
  });

  test("AC2: an oversized plugin after_tool result is truncated by the built-in handler registered last", async () => {
    const registry = createLoopEventRegistry();
    const oversized = "x".repeat(MODEL_MAX_BYTES + 100);
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("after_tool", () => ({ content: oversized }))),
      loopHandlerContext: CTX,
    });

    const patch = await registry.dispatch("after_tool", afterToolPayload("small original"));

    const content = patch.content ?? "";
    expect(content).not.toEqual(oversized);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(MODEL_MAX_BYTES);
    // The marker is what a truncated result carries; it is the truncation
    // handler's own output, proving it ran AFTER the plugin's patch.
    expect(content).toContain("[truncated");
  });

  test("AC2 (boundary): a within-budget plugin after_tool result is the dispatch result", async () => {
    const registry = createLoopEventRegistry();
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("after_tool", () => ({ content: "shaped-small" }))),
      loopHandlerContext: CTX,
    });

    const patch = await registry.dispatch("after_tool", afterToolPayload("small original"));

    expect(patch.content).toBe("shaped-small");
  });

  test("AC3: with two after_tool entries the second handler receives the content the first returned", async () => {
    const registry = createLoopEventRegistry();
    const secondSaw: string[] = [];
    install(registry, {
      loopHandlers: handlerSet(
        pluginEntry("after_tool", () => ({ content: "from-first" }), "first-plugin"),
        pluginEntry(
          "after_tool",
          (payload) => {
            if ("content" in payload) secondSaw.push(payload.content);
            return undefined;
          },
          "second-plugin",
        ),
      ),
      loopHandlerContext: CTX,
    });

    await registry.dispatch("after_tool", afterToolPayload("original"));

    expect(secondSaw).toEqual(["from-first"]);
  });

  test("AC3 (boundary): the first after_tool entry is handed the original content, not an already-shaped one", async () => {
    const registry = createLoopEventRegistry();
    const firstSaw: string[] = [];
    install(registry, {
      loopHandlers: handlerSet(
        pluginEntry(
          "after_tool",
          (payload) => {
            if ("content" in payload) firstSaw.push(payload.content);
            return { content: "from-first" };
          },
          "first-plugin",
        ),
        pluginEntry("after_tool", () => ({ content: "from-second" }), "second-plugin"),
      ),
      loopHandlerContext: CTX,
    });

    const patch = await registry.dispatch("after_tool", afterToolPayload("original"));

    expect(firstSaw).toEqual(["original"]);
    // ...and the LAST entry's patch is what the dispatch settles on.
    expect(patch.content).toBe("from-second");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4–AC5 — a built-in refusal short-circuits the plugin entries
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — registerBuiltinLoopHandlers: built-in before_tool refusals", () => {
  test("AC4: a call that fails schema validation is blocked without reaching the plugin handler", async () => {
    const registry = createLoopEventRegistry();
    const seen: BeforeToolPayload["call"][] = [];
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("before_tool", recordingBeforeToolHandler(seen))),
      loopHandlerContext: CTX,
    });

    // Control: an ordinary call DOES reach the plugin, so an absent second
    // entry below is the block's doing and not a plugin that never installed.
    await registry.dispatch("before_tool", readCall("valid-1", { path: "a.ts" }));
    const outcome = await registry.dispatch("before_tool", readCall("invalid-1", { path: 42 }));

    expect(outcome.kind).toBe("block");
    expect(seen.map((call) => call.id)).toEqual(["valid-1"]);
  });

  test("AC4 (boundary): a call whose tool is not in the catalogue is not blocked and reaches the plugin", async () => {
    const registry = createLoopEventRegistry();
    const seen: BeforeToolPayload["call"][] = [];
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("before_tool", recordingBeforeToolHandler(seen))),
      loopHandlerContext: CTX,
    });

    // No schema for "Unknown" in the advertised tools: the validator cannot
    // judge it, so the fail-open path must leave the call to the plugin.
    const outcome = await registry.dispatch("before_tool", {
      call: { id: "u1", name: "Unknown", input: { anything: 42 } },
      tools: READ_TOOLS,
    });

    expect(outcome.kind).toBe("allow");
    expect(seen.map((call) => call.id)).toEqual(["u1"]);
  });

  test("AC5: a spin-breaker stop terminates the batch without reaching the plugin handler", async () => {
    const registry = createLoopEventRegistry();
    const seen: BeforeToolPayload["call"][] = [];
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("before_tool", recordingBeforeToolHandler(seen))),
      loopHandlerContext: CTX,
      // Allows the first call and stops on the second occurrence of the same
      // key — so the control call below proves the plugin was installed.
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 0,
        maxNudges: 0,
        stopAfterRepeats: 2,
      }),
    });

    const allowed = await registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    const stopped = await registry.dispatch("before_tool", readCall("c2", { path: "a.ts" }));

    expect(allowed.kind).toBe("allow");
    expect(stopped.kind).toBe("terminate");
    expect(seen.map((call) => call.id)).toEqual(["c1"]);
  });

  test("AC5 (boundary): a nudge from the breaker does not short-circuit the plugin handler", async () => {
    const registry = createLoopEventRegistry();
    const seen: BeforeToolPayload["call"][] = [];
    install(registry, {
      loopHandlers: handlerSet(pluginEntry("before_tool", recordingBeforeToolHandler(seen))),
      loopHandlerContext: CTX,
      spinBreaker: createSpinBreaker({
        ...DEFAULT_SPIN_BREAKER_SETTINGS,
        nudgeAfterRepeats: 1,
        maxNudges: 3,
        stopAfterRepeats: 50,
      }),
    });

    await registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    const nudged = await registry.dispatch("before_tool", readCall("c2", { path: "a.ts" }));

    expect(nudged.kind).toBe("nudge");
    expect(seen.map((call) => call.id)).toEqual(["c1", "c2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6–AC7 — one installation per registry, with the per-turn state repointed
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — registerBuiltinLoopHandlers: a reused registry", () => {
  test("AC6: installing the same set twice on one registry invokes a plugin handler once per dispatch", async () => {
    const registry = createLoopEventRegistry();
    let pluginCalls = 0;
    const set = handlerSet(
      pluginEntry("before_tool", () => {
        pluginCalls += 1;
        return undefined;
      }),
    );

    install(registry, { loopHandlers: set, loopHandlerContext: CTX });
    install(registry, { loopHandlers: set, loopHandlerContext: CTX });

    await registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    expect(pluginCalls).toBe(1);

    await registry.dispatch("before_tool", readCall("c2", { path: "b.ts" }));
    expect(pluginCalls).toBe(2);
  });

  test("AC6 (boundary): the same set installed on a second registry is registered there too", async () => {
    let pluginCalls = 0;
    const set = handlerSet(
      pluginEntry("before_tool", () => {
        pluginCalls += 1;
        return undefined;
      }),
    );
    const first = createLoopEventRegistry();
    const second = createLoopEventRegistry();

    install(first, { loopHandlers: set, loopHandlerContext: CTX });
    install(second, { loopHandlers: set, loopHandlerContext: CTX });
    await first.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    await second.dispatch("before_tool", readCall("c2", { path: "b.ts" }));

    expect(pluginCalls).toBe(2);
  });

  test("AC7: a second install with a different context hands the plugin the second context", async () => {
    const registry = createLoopEventRegistry();
    const seenSessions: string[] = [];
    const set = handlerSet(
      pluginEntry("before_tool", (_payload, ctx) => {
        seenSessions.push(ctx.sessionName);
        return undefined;
      }),
    );

    install(registry, { loopHandlers: set, loopHandlerContext: { sessionName: "first-turn" } });
    await registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    install(registry, { loopHandlers: set, loopHandlerContext: { sessionName: "second-turn" } });
    await registry.dispatch("before_tool", readCall("c2", { path: "b.ts" }));

    expect(seenSessions).toEqual(["first-turn", "second-turn"]);
  });

  test("AC7 (boundary): the repointed context holds for every later dispatch, not just the first", async () => {
    const registry = createLoopEventRegistry();
    const seenSessions: string[] = [];
    const set = handlerSet(
      pluginEntry("before_tool", (_payload, ctx) => {
        seenSessions.push(ctx.sessionName);
        return undefined;
      }),
    );

    install(registry, { loopHandlers: set, loopHandlerContext: { sessionName: "first-turn" } });
    await registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    install(registry, { loopHandlers: set, loopHandlerContext: { sessionName: "second-turn" } });
    await registry.dispatch("before_tool", readCall("c2", { path: "b.ts" }));
    await registry.dispatch("before_tool", readCall("c3", { path: "c.ts" }));

    expect(seenSessions).toEqual(["first-turn", "second-turn", "second-turn"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — the per-turn signal reaches the wrapped plugin handler
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — registerBuiltinLoopHandlers: the per-turn signal", () => {
  test("AC8: aborting the install-time signal while a plugin before_tool handler is pending blocks the call, naming the plugin", async () => {
    const registry = createLoopEventRegistry();
    const controller = new AbortController();
    let invoked = false;
    install(registry, {
      loopHandlers: handlerSet(
        pluginEntry("before_tool", () => {
          invoked = true;
          return neverSettles();
        }),
      ),
      loopHandlerContext: CTX,
      signal: controller.signal,
    });

    const startedAt = Date.now();
    const pending = registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    await waitForCondition(() => invoked, 1000);
    controller.abort();
    const outcome = await pending;
    // The abort, not the 10s deadline, must have settled the dispatch: a
    // regression that stopped the wrapper subscribing would still yield this
    // block, but only after the timeout.
    expect(Date.now() - startedAt).toBeLessThan(1000);

    expect(outcome.kind).toBe("block");
    expect(outcome).toHaveProperty("isError", true);
    if (outcome.kind !== "block") throw new Error("the dispatch did not resolve to a block");
    expect(outcome.content).toContain("'p'");
  });

  test("AC8 (boundary): the abort answers for the pending call only — a later after_tool dispatch still gets the plugin's patch", async () => {
    const registry = createLoopEventRegistry();
    const controller = new AbortController();
    let invoked = false;
    install(registry, {
      loopHandlers: handlerSet(
        pluginEntry("before_tool", () => {
          invoked = true;
          return neverSettles();
        }),
        pluginEntry("after_tool", () => ({ content: "shaped-after-abort" }), "shaper-plugin"),
      ),
      loopHandlerContext: CTX,
      signal: controller.signal,
    });

    const startedAt = Date.now();
    const pending = registry.dispatch("before_tool", readCall("c1", { path: "a.ts" }));
    await waitForCondition(() => invoked, 1000);
    controller.abort();
    await pending;
    expect(Date.now() - startedAt).toBeLessThan(1000);

    const patch = await registry.dispatch("after_tool", afterToolPayload("original"));

    expect(patch.content).toBe("shaped-after-abort");
  });
});
