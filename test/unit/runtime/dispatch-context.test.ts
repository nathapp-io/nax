/**
 * Type-level tests for DispatchContext hierarchy (ADR-020 Wave 2).
 *
 * Each test creates a value of the subtype and assigns it to the base type.
 * If the subtype does not extend DispatchContext, TypeScript compilation fails.
 *
 * These tests are validated by `bun run check:dispatch-context`, which runs
 * `bun x tsc --project tsconfig.dispatch-context.json --noEmit` (that config
 * includes this file only) and is gated in CI.
 */

import { describe, expect, test } from "bun:test";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import type { AcceptanceLoopContext } from "@/execution/lifecycle/acceptance-loop";
import type { RunCompletionOptions } from "@/execution/lifecycle/run-completion";
import type { RunnerExecutionOptions } from "@/execution/runner-execution";
import type { PipelineContext } from "@/pipeline/types";
import type { RoutingContext } from "@/routing/router";
import type { DispatchContext } from "@/runtime/dispatch-context";
import type { SessionRunnerContext } from "@/session/session-runner";

function assertExtends<T extends U, U>(_value: T): void {}

function makeDispatchContext(): DispatchContext {
  return {
    agentManager: {} as import("@/agents/manager-types").IAgentManager,
    sessionManager: {} as import("@/session").ISessionManager,
    runtime: {} as import("@/runtime").NaxRuntime,
    abortSignal: new AbortController().signal,
  };
}

describe("DispatchContext type hierarchy", () => {
  test("PipelineContext extends DispatchContext", () => {
    const ctx = {} as PipelineContext;
    const base: DispatchContext = ctx;
    assertExtends<PipelineContext, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });

  test("AcceptanceLoopContext extends DispatchContext", () => {
    const ctx = {} as AcceptanceLoopContext;
    const base: DispatchContext = ctx;
    assertExtends<AcceptanceLoopContext, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });

  test("SequentialExecutionContext extends DispatchContext", () => {
    const ctx = {} as SequentialExecutionContext;
    const base: DispatchContext = ctx;
    assertExtends<SequentialExecutionContext, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });

  test("RoutingContext extends DispatchContext", () => {
    const ctx = {} as RoutingContext;
    const base: DispatchContext = ctx;
    assertExtends<RoutingContext, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });

  test("RunnerExecutionOptions extends DispatchContext", () => {
    const ctx = {} as RunnerExecutionOptions;
    const base: DispatchContext = ctx;
    assertExtends<RunnerExecutionOptions, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });

  test("RunCompletionOptions extends DispatchContext", () => {
    const ctx = {} as RunCompletionOptions;
    const base: DispatchContext = ctx;
    assertExtends<RunCompletionOptions, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });

  test("SessionRunnerContext extends DispatchContext", () => {
    const ctx = {} as SessionRunnerContext;
    const base: DispatchContext = ctx;
    assertExtends<SessionRunnerContext, DispatchContext>(ctx);
    expect(base).toBeDefined();
  });
});

describe("DispatchContext required fields", () => {
  test("all four fields are required", () => {
    const ctx = makeDispatchContext();
    expect(ctx.agentManager).toBeDefined();
    expect(ctx.sessionManager).toBeDefined();
    expect(ctx.runtime).toBeDefined();
    expect(ctx.abortSignal).toBeDefined();
  });
});
