/**
 * US-004 — `SessionManager` scoped to the run's plugin loop handlers.
 *
 * The manager is the delivery seam: `configureLoopHandlers(set)` is how run
 * setup hands one loaded set to a session manager, and `sendPrompt` is where
 * that set, plus the facts the plugins read it against, reach the adapter's
 * `sendTurn`. These tests drive a REAL `SessionManager` over a mock adapter and
 * observe the options the adapter received — the only place the delivery is
 * visible — and, for the native-only scope, the `plugins` info line the manager
 * emits at most once per manager.
 *
 * The AC id is the test-name prefix.
 */

import { describe, expect, mock, test } from "bun:test";
import { assertDefined, makeAgentAdapter, withInfoSpy } from "@test/helpers";
import type { LoopHandlerEntry, LoopHandlerSet } from "@/agents/native/session/loop-events/types";
import type { SendTurnOpts, SessionHandle, TurnResult } from "@/agents/session-types";
import { NATIVE_AGENT_NAME } from "@/config";
import { SessionManager } from "@/session/manager";
import type { OpenSessionRequest } from "@/session/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const WORKDIR = "/tmp/nax-loop-handler-manager-test";
const STORY_ID = "US-004";
const FEATURE = "plugin-loop-handlers";
const MODEL_DEF = { provider: "anthropic", model: "claude-sonnet-4-5" };

/** The one `plugins` info line a native-only feature logs to non-native sessions. */
const NON_NATIVE_INFO_LINE = "loop handlers apply to the native agent only";

const MOCK_TURN: TurnResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 0,
};

function openRequest(overrides: Partial<OpenSessionRequest> = {}): OpenSessionRequest {
  return {
    agentName: "claude",
    role: "implementer",
    workdir: WORKDIR,
    pipelineStage: "run",
    modelDef: MODEL_DEF,
    timeoutSeconds: 30,
    ...overrides,
  };
}

const NO_PATCH: LoopHandlerEntry["handler"] = () => undefined;

function handlerSet(...entries: LoopHandlerEntry[]): LoopHandlerSet {
  return Object.freeze(entries);
}

const SET: LoopHandlerSet = handlerSet({ plugin: "p", event: "before_turn", handler: NO_PATCH });

/** An adapter whose `sendTurn` records the options the manager handed it. */
function capturingAdapter(agentName: string): {
  adapter: ReturnType<typeof makeAgentAdapter>;
  sent: SendTurnOpts[];
} {
  const sent: SendTurnOpts[] = [];
  const adapter = makeAgentAdapter({
    openSession: mock(
      async (name: string): Promise<SessionHandle> => ({
        id: name,
        agentName,
        modelDef: MODEL_DEF,
        role: "implementer",
      }),
    ),
    sendTurn: mock(async (_handle: SessionHandle, _prompt: string, opts: SendTurnOpts) => {
      sent.push(opts);
      return MOCK_TURN;
    }),
  });
  return { adapter, sent };
}

function onlySent(sent: readonly SendTurnOpts[]): SendTurnOpts {
  const opts = sent[0];
  assertDefined(opts, "the options adapter.sendTurn received");
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC7 / AC8 — what reaches the adapter's sendTurn
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — SessionManager.sendPrompt: forwarding the configured set", () => {
  test("AC7: passes the set and the descriptor's storyId to adapter.sendTurn", async () => {
    const { adapter, sent } = capturingAdapter(NATIVE_AGENT_NAME);
    const manager = new SessionManager({ getAdapter: () => adapter });
    manager.configureLoopHandlers(SET);
    const handle = await manager.openSession(
      "nax-loop-handler-native",
      openRequest({ agentName: NATIVE_AGENT_NAME, storyId: STORY_ID, featureName: FEATURE }),
    );

    await manager.sendPrompt(handle, "hi");

    const opts = onlySent(sent);
    expect(opts.loopHandlers).toBe(SET);
    expect(opts.loopHandlerContext?.storyId).toBe(STORY_ID);
  });

  test("AC7 (boundary): a native session with no storyId in its descriptor carries no storyId key", async () => {
    const { adapter, sent } = capturingAdapter(NATIVE_AGENT_NAME);
    const manager = new SessionManager({ getAdapter: () => adapter });
    manager.configureLoopHandlers(SET);
    const handle = await manager.openSession("nax-loop-handler-nostory", openRequest({ agentName: NATIVE_AGENT_NAME }));

    await manager.sendPrompt(handle, "hi");

    const ctx = onlySent(sent).loopHandlerContext;
    assertDefined(ctx, "the loopHandlerContext handed to adapter.sendTurn");
    expect("storyId" in ctx).toBe(false);
  });

  test("AC8: without a configured set, adapter.sendTurn receives options with no loopHandlers key", async () => {
    const { adapter, sent } = capturingAdapter(NATIVE_AGENT_NAME);
    const manager = new SessionManager({ getAdapter: () => adapter });
    const handle = await manager.openSession(
      "nax-loop-handler-unconfigured",
      openRequest({ agentName: NATIVE_AGENT_NAME, storyId: STORY_ID }),
    );

    await manager.sendPrompt(handle, "hi");

    const opts = onlySent(sent);
    expect("loopHandlers" in opts).toBe(false);
    expect("loopHandlerContext" in opts).toBe(false);
  });

  test("AC8 (boundary): configuring an empty set leaves both keys off the adapter options", async () => {
    const { adapter, sent } = capturingAdapter(NATIVE_AGENT_NAME);
    const manager = new SessionManager({ getAdapter: () => adapter });
    manager.configureLoopHandlers(handlerSet());
    const handle = await manager.openSession(
      "nax-loop-handler-empty",
      openRequest({ agentName: NATIVE_AGENT_NAME, storyId: STORY_ID }),
    );

    await manager.sendPrompt(handle, "hi");

    expect("loopHandlers" in onlySent(sent)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — the set applies to the native agent only, said once
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — SessionManager.sendPrompt: the native-only scope line", () => {
  test("AC9: two non-native sessions with a non-empty set log the plugins info line exactly once", async () => {
    await withInfoSpy(async (infoSpy) => {
      const { adapter } = capturingAdapter("claude");
      const manager = new SessionManager({ getAdapter: () => adapter });
      manager.configureLoopHandlers(SET);
      const first = await manager.openSession("nax-loop-handler-acp-1", openRequest({ storyId: STORY_ID }));
      const second = await manager.openSession("nax-loop-handler-acp-2", openRequest({ storyId: STORY_ID }));

      await manager.sendPrompt(first, "one");
      await manager.sendPrompt(second, "two");

      const lines = infoSpy.mock.calls.filter((call) => call[0] === "plugins" && call[1] === NON_NATIVE_INFO_LINE);
      expect(lines).toHaveLength(1);
    });
  });

  test("AC9 (boundary): a native session receiving the same set never logs it", async () => {
    await withInfoSpy(async (infoSpy) => {
      const { adapter } = capturingAdapter(NATIVE_AGENT_NAME);
      const manager = new SessionManager({ getAdapter: () => adapter });
      manager.configureLoopHandlers(SET);
      const handle = await manager.openSession(
        "nax-loop-handler-native-line",
        openRequest({ agentName: NATIVE_AGENT_NAME, storyId: STORY_ID }),
      );

      await manager.sendPrompt(handle, "hi");

      const lines = infoSpy.mock.calls.filter((call) => call[0] === "plugins" && call[1] === NON_NATIVE_INFO_LINE);
      expect(lines).toHaveLength(0);
    });
  });

  test("AC9 (boundary): a non-native session with the default empty set logs nothing", async () => {
    await withInfoSpy(async (infoSpy) => {
      const { adapter } = capturingAdapter("claude");
      const manager = new SessionManager({ getAdapter: () => adapter });
      const handle = await manager.openSession("nax-loop-handler-acp-empty", openRequest({ storyId: STORY_ID }));

      await manager.sendPrompt(handle, "hi");

      const lines = infoSpy.mock.calls.filter((call) => call[0] === "plugins" && call[1] === NON_NATIVE_INFO_LINE);
      expect(lines).toHaveLength(0);
    });
  });
});
