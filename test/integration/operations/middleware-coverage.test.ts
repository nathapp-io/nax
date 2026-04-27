/**
 * Middleware coverage for callOp `kind:"run"` dispatch (Findings 1 + 5).
 *
 * Asserts that `kind:"run"` operations dispatched via callOp flow through the
 * AgentManager middleware chain (audit, cost, cancellation, logging). Before
 * the ADR-019 §5 realignment, the run-path called `sessionManager.runInSession`
 * directly and bypassed the chain — `kind:"run"` calls never reached
 * CostAggregator or PromptAuditor. This test guards that boundary so it cannot
 * drift again silently.
 *
 * `kind:"complete"` middleware coverage is verified elsewhere (audit/cost
 * unit tests in test/unit/runtime/middleware/).
 */

import { describe, expect, mock, test } from "bun:test";
import { AgentManager } from "../../../src/agents/manager";
import type { SessionHandle, TurnResult } from "../../../src/agents/types";
import { DEFAULT_CONFIG, pickSelector } from "../../../src/config";
import { callOp } from "../../../src/operations/call";
import type { RunOperation } from "../../../src/operations/types";
import { MiddlewareChain } from "../../../src/runtime/agent-middleware";
import type { AgentMiddleware, MiddlewareContext } from "../../../src/runtime/agent-middleware";
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

interface RecordedCall {
  agentName: string;
  kind: MiddlewareContext["kind"];
  promptIncludes?: string;
}

function makeRecorder(): { mw: AgentMiddleware; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const mw: AgentMiddleware = {
    name: "test-recorder",
    after(ctx: MiddlewareContext, _result: unknown, _durationMs: number): void {
      calls.push({
        agentName: ctx.agentName,
        kind: ctx.kind,
        promptIncludes: ctx.prompt?.slice(0, 200),
      });
    },
  };
  return { mw, calls };
}

const noFallbackOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...runOp,
  name: "mw-coverage-no-fallback",
  noFallback: true,
};

describe("callOp middleware coverage (ADR-018 Wave 2 + ADR-019 §5)", () => {
  test("kind:run dispatches through middleware chain via runAsSession", async () => {
    const config = makeNaxConfig();
    const realManager = new AgentManager(config);
    const { mw, calls } = makeRecorder();

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({ id: "test-handle", agentName: "claude" }) as SessionHandle),
      sendPrompt: mock(async (_handle: SessionHandle, prompt: string): Promise<TurnResult> => ({
        output: `runOp says: ${prompt}`,
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        internalRoundTrips: 1,
        cost: { total: 0.001 },
      })),
    });

    // makeTestRuntime → createRuntime calls configureRuntime() on the manager,
    // which overwrites sendPrompt with sessionManager.sendPrompt. Our recorded
    // middleware survives because configureRuntime only overrides middleware
    // when the new opts pass it explicitly — the default chain is the runtime
    // chain. We re-apply our recorder middleware AFTER createRuntime so it
    // wins.
    const runtime = makeTestRuntime({ agentManager: realManager, sessionManager });
    realManager.configureRuntime({ middleware: MiddlewareChain.from([mw]) });

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

    // Pre-fix: zero entries (middleware bypassed). Post-fix: exactly one entry.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("run");
    expect(calls[0]?.agentName).toBe("claude");
    expect(calls[0]?.promptIncludes).toContain("hello-from-run-op");
  });

  test("kind:run with noFallback:true ALSO fires middleware (C1 regression)", async () => {
    // Regression for review-Finding C1: an earlier draft routed noFallback ops
    // through wrapAdapterAsManager, whose runWithFallback ignored executeHop
    // and bypassed the middleware chain. Confirm the fixed path goes through
    // the real AgentManager so middleware fires regardless of noFallback.
    const config = makeNaxConfig();
    const realManager = new AgentManager(config);
    const { mw, calls } = makeRecorder();

    const sessionManager = makeSessionManager({
      openSession: mock(async () => ({ id: "test-handle", agentName: "claude" }) as SessionHandle),
      sendPrompt: mock(async (_handle: SessionHandle, prompt: string): Promise<TurnResult> => ({
        output: `noFallback says: ${prompt}`,
        tokenUsage: { inputTokens: 5, outputTokens: 5 },
        internalRoundTrips: 1,
        cost: { total: 0.0005 },
      })),
    });
    const runtime = makeTestRuntime({ agentManager: realManager, sessionManager });
    realManager.configureRuntime({ middleware: MiddlewareChain.from([mw]) });

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

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("run");
    expect(calls[0]?.promptIncludes).toContain("no-fallback-prompt");
  });
});
