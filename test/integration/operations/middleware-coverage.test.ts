/**
 * Dispatch-event coverage for callOp `kind:"run"` boundary (ADR-020 Wave 1).
 *
 * Asserts that `kind:"run"` operations dispatched via callOp emit a
 * `SessionTurnDispatchEvent` on the runtime bus — the ADR-020 replacement for
 * the old middleware `after()` hook. Before ADR-020, audit/cost/logging
 * were driven by MiddlewareContext.after; after ADR-020 they are driven by
 * IDispatchEventBus.onDispatch.
 *
 * Originally named "middleware-coverage" (ADR-018 Wave 2 + ADR-019 §5);
 * renamed to reflect the ADR-020 migration of the audit/cost boundary.
 *
 * `kind:"complete"` dispatch coverage is verified in
 * test/unit/runtime/middleware/{audit,cost,logging}.test.ts.
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { SessionHandle, TurnResult } from "../../../src/agents/types";
import { DEFAULT_CONFIG, pickSelector } from "../../../src/config";
import { callOp } from "../../../src/operations/call";
import type { RunOperation } from "../../../src/operations/types";
import type { SessionTurnDispatchEvent } from "../../../src/runtime/dispatch-events";
import { makeNaxConfig, makeSessionManager, makeTestRuntime } from "../../helpers";

const sel = pickSelector("mw-coverage", "routing");

const runOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "mw-coverage-run",
  stage: "run",
  config: sel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const noFallbackOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...runOp,
  name: "mw-coverage-no-fallback",
  noFallback: true,
};

describe("callOp dispatch coverage (ADR-018 Wave 2 + ADR-019 §5, migrated by ADR-020)", () => {
  test("kind:run emits SessionTurnDispatchEvent on runtime.dispatchEvents via runAsSession", async () => {
    const config = makeNaxConfig();
    const realManager = new AgentManager(config);

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({ id: "test-handle", agentName: "claude" }) as SessionHandle),
      sendPrompt: mock(async (_handle: SessionHandle, prompt: string): Promise<TurnResult> => ({
        output: `runOp says: ${prompt}`,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        internalRoundTrips: 1,
        estimatedCostUsd: 0.001,
      })),
    });

    const runtime = makeTestRuntime({ agentManager: realManager, sessionManager });

    const received: SessionTurnDispatchEvent[] = [];
    runtime.dispatchEvents.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      runOp,
      { text: "hello-from-run-op" },
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("session-turn");
    expect(received[0]?.agentName).toBe("claude");
    expect(received[0]?.prompt).toContain("hello-from-run-op");
    expect(received[0]?.origin).toBe("runAsSession");
  });

  test("kind:run with noFallback:true ALSO emits SessionTurnDispatchEvent (C1 regression)", async () => {
    // Regression for review-Finding C1: ensures noFallback ops still reach the
    // audit/cost boundary via dispatch events (previously via middleware.after).
    const config = makeNaxConfig();
    const realManager = new AgentManager(config);

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({ id: "test-handle", agentName: "claude" }) as SessionHandle),
      sendPrompt: mock(async (_handle: SessionHandle, prompt: string): Promise<TurnResult> => ({
        output: `noFallback says: ${prompt}`,
        tokenUsage: { inputTokens: 5, outputTokens: 5 },
        internalRoundTrips: 1,
        estimatedCostUsd: 0.0005,
      })),
    });

    const runtime = makeTestRuntime({ agentManager: realManager, sessionManager });

    const received: SessionTurnDispatchEvent[] = [];
    runtime.dispatchEvents.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-002",
      },
      noFallbackOp,
      { text: "no-fallback-prompt" },
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("session-turn");
    expect(received[0]?.prompt).toContain("no-fallback-prompt");
  });
});
