/**
 * The four ADR-020 DispatchContext fields, as a spreadable fixture.
 *
 * `DispatchContext` requires `agentManager`, `sessionManager`, `runtime` and
 * `abortSignal` on every context that dispatches agent work — pipeline stages,
 * routing, lifecycle options, acceptance, debate. Tests that build such a
 * context by hand were missing all four.
 *
 * The three object fields come from ONE runtime rather than three independent
 * mocks: in production `ctx.agentManager === ctx.runtime.agentManager`, and a
 * fixture that breaks that identity lets a test pass while the code under test
 * dispatches through a manager the test never observes.
 *
 * ```ts
 * const context: RoutingContext = { config: DEFAULT_CONFIG, ...makeDispatchContext() };
 * ```
 *
 * The runtime is built by `makeMockRuntime`, so it is tracked and closed by the
 * central `afterEach` in test/helpers/runtime.ts — callers need no teardown.
 * Pass `runtime` when the test already has one; its managers are then reused.
 */
import type { DispatchContext, NaxRuntime } from "@/runtime";
import { type MockRuntimeOptions, makeMockRuntime } from "./runtime";

export interface DispatchContextOptions extends MockRuntimeOptions {
  /** Reuse an existing runtime instead of building one. */
  runtime?: NaxRuntime;
  /** Defaults to the signal of a fresh, never-aborted controller. */
  abortSignal?: AbortSignal;
}

export function makeDispatchContext(opts: DispatchContextOptions = {}): DispatchContext {
  const runtime = opts.runtime ?? makeMockRuntime(opts);
  return {
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: opts.abortSignal ?? new AbortController().signal,
  };
}
