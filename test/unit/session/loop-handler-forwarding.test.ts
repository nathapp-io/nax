/**
 * US-004 — `buildLoopHandlerTurnOpts()`: the run's plugin handler set turned
 * into the per-turn options `SessionManager.sendPrompt` spreads into
 * `adapter.sendTurn`.
 *
 * The set is delivered to a native session through exactly one translation:
 * `{ handle, descriptor, set }` in, `{ loopHandlers, loopHandlerContext }` out.
 * Every criterion here observes that translation's result rather than its
 * internals — what `loopHandlers` is, what the context says about the session
 * it is running in, and that the empty/foreign-agent cases produce NO keys at
 * all (a key carrying `undefined` would still reach the adapter's conditional
 * spreads as "supplied").
 *
 * Each test invokes the module at runtime and asserts its observable result;
 * the AC id is the test-name prefix.
 */

import { describe, expect, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import type { LoopHandlerEntry, LoopHandlerSet } from "@/agents/native/session/loop-events/types";
import type { SessionHandle } from "@/agents/session-types";
import { NATIVE_AGENT_NAME } from "@/config";
import { buildLoopHandlerTurnOpts } from "@/session/loop-handler-forwarding";
import type { SessionDescriptor } from "@/session/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_DEF = { provider: "anthropic", model: "claude-sonnet-4-5" };

const SESSION_NAME = "nax-loop-handler-forwarding";

/** The handle a native session's turn arrives with. */
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    id: SESSION_NAME,
    agentName: NATIVE_AGENT_NAME,
    role: "implementer",
    modelDef: MODEL_DEF,
    ...overrides,
  };
}

/** The descriptor `SessionManager` looks up for that handle. */
function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id: "sess-descriptor",
    role: "implementer",
    state: "RUNNING",
    agent: NATIVE_AGENT_NAME,
    workdir: "/repo/checkout",
    featureName: "plugin-loop-handlers",
    storyId: "US-004",
    protocolIds: { recordId: null, sessionId: null },
    completedStages: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A handler that answers nothing — the shape a plugin may legitimately return. */
const NO_PATCH: LoopHandlerEntry["handler"] = () => undefined;

function entry(event: LoopHandlerEntry["event"], plugin: string): LoopHandlerEntry {
  return { plugin, event, handler: NO_PATCH };
}

function handlerSet(...entries: LoopHandlerEntry[]): LoopHandlerSet {
  return Object.freeze(entries);
}

const SET: LoopHandlerSet = handlerSet(entry("before_turn", "seed-plugin"));
const EMPTY_SET: LoopHandlerSet = handlerSet();

/** The context of a call that produced one, or a failed test. */
function contextOf(opts: ReturnType<typeof buildLoopHandlerTurnOpts>) {
  const ctx = opts.loopHandlerContext;
  assertDefined(ctx, "the loopHandlerContext built for a native handle");
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — an empty set produces no options
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — buildLoopHandlerTurnOpts: the empty set", () => {
  test("AC1: returns {} when the set is empty", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: EMPTY_SET });

    expect(opts).toEqual({});
    expect(Object.keys(opts)).toEqual([]);
  });

  test("AC1 (boundary): carries neither key, so the adapter's spreads add nothing", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: EMPTY_SET });

    expect("loopHandlers" in opts).toBe(false);
    expect("loopHandlerContext" in opts).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — a foreign agent's session never receives the handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — buildLoopHandlerTurnOpts: a non-native handle", () => {
  test("AC2: returns {} when handle.agentName is not NATIVE_AGENT_NAME, even with a non-empty set", () => {
    const opts = buildLoopHandlerTurnOpts({
      handle: handle({ agentName: "claude" }),
      descriptor: descriptor(),
      set: SET,
    });

    expect(opts).toEqual({});
    expect(Object.keys(opts)).toEqual([]);
  });

  test("AC2 (boundary): a non-native handle with an empty set also returns {}", () => {
    const opts = buildLoopHandlerTurnOpts({
      handle: handle({ agentName: "codex" }),
      descriptor: descriptor(),
      set: EMPTY_SET,
    });

    expect(opts).toEqual({});
    expect("loopHandlerContext" in opts).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — the set itself travels
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — buildLoopHandlerTurnOpts: the delivered set", () => {
  test("AC3: a native handle with a non-empty set returns loopHandlers equal to the set", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: SET });

    expect(opts.loopHandlers).toBe(SET);
  });

  test("AC3 (boundary): every entry of a two-entry set travels, in order", () => {
    const first = entry("before_turn", "first-plugin");
    const second = entry("before_tool", "second-plugin");
    const twoEntrySet = handlerSet(first, second);

    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: twoEntrySet });

    assertDefined(opts.loopHandlers, "the loopHandlers for a native handle");
    expect(opts.loopHandlers).toHaveLength(2);
    expect(opts.loopHandlers[0]).toBe(first);
    expect(opts.loopHandlers[1]).toBe(second);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — the context describes the session the handler runs in
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — buildLoopHandlerTurnOpts: the context facts", () => {
  test("AC4: sessionName, role, storyId, feature, workdir, model and provider all come from the lookup", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: SET });
    const ctx = contextOf(opts);

    expect(ctx.sessionName).toBe(SESSION_NAME);
    expect(ctx.role).toBe("implementer");
    expect(ctx.storyId).toBe("US-004");
    expect(ctx.feature).toBe("plugin-loop-handlers");
    expect(ctx.workdir).toBe("/repo/checkout");
    expect(ctx.model).toBe("claude-sonnet-4-5");
    expect(ctx.provider).toBe("anthropic");
  });

  test("AC4 (boundary): sessionName is the handle's id, not the descriptor's", () => {
    const opts = buildLoopHandlerTurnOpts({
      handle: handle({ id: "handle-id" }),
      descriptor: descriptor({ id: "descriptor-id" }),
      set: SET,
    });

    expect(contextOf(opts).sessionName).toBe("handle-id");
  });

  test("AC4 (boundary): a handle with no modelDef carries no model and no provider key", () => {
    const opts = buildLoopHandlerTurnOpts({
      handle: handle({ modelDef: undefined }),
      descriptor: descriptor(),
      set: SET,
    });
    const ctx = contextOf(opts);

    expect("model" in ctx).toBe(false);
    expect("provider" in ctx).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — the context a plugin handler reads is frozen
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — buildLoopHandlerTurnOpts: the frozen context", () => {
  test("AC5: Object.isFrozen is true for the loopHandlerContext", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: SET });

    expect(Object.isFrozen(contextOf(opts))).toBe(true);
  });

  test("AC5 (boundary): the frozen context's own properties are non-writable", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: descriptor(), set: SET });

    const role = Object.getOwnPropertyDescriptor(contextOf(opts), "role");
    expect(role?.writable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — no descriptor: the handle's own role, and no session facts
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — buildLoopHandlerTurnOpts: no descriptor found", () => {
  test("AC6: role falls back to handle.role and storyId/feature/workdir are absent", () => {
    const opts = buildLoopHandlerTurnOpts({
      handle: handle({ role: "verifier" }),
      descriptor: undefined,
      set: SET,
    });
    const ctx = contextOf(opts);

    expect(ctx.role).toBe("verifier");
    expect("storyId" in ctx).toBe(false);
    expect("feature" in ctx).toBe(false);
    expect("workdir" in ctx).toBe(false);
  });

  test("AC6 (boundary): a handle with no role leaves the role key out too", () => {
    const opts = buildLoopHandlerTurnOpts({
      handle: handle({ role: undefined }),
      descriptor: undefined,
      set: SET,
    });

    expect("role" in contextOf(opts)).toBe(false);
  });

  test("AC6 (boundary): the handlers still travel when no descriptor was found", () => {
    const opts = buildLoopHandlerTurnOpts({ handle: handle(), descriptor: undefined, set: SET });

    expect(opts.loopHandlers).toBe(SET);
    expect(Object.isFrozen(contextOf(opts))).toBe(true);
  });
});
