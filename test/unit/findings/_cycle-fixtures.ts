/**
 * Shared fixtures for the runFixCycle test files (cycle.test.ts,
 * cycle-retirement.test.ts). Extracted when the cycle tests were split under the
 * 800-line cap — two copies of an 80-line context/strategy fixture would drift
 * silently, and the drift would look like a behaviour difference between the files.
 *
 * Follows the `_tdd-test-helpers.ts` precedent: leading underscore, not a `.test.ts`,
 * so the runner does not pick it up as a suite.
 */

import { mock } from "bun:test";
import type { FixCycle, FixCycleContext, FixStrategy } from "@/findings";
import type { Finding } from "@/findings";
import type { CallOpFn } from "@/findings/cycle";
import { makeMockAgentManager, makeNaxConfig } from "@test/helpers";

export function makeFinding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return { severity: "error", category: "test", ...overrides };
}

export const lintA = makeFinding({ source: "lint", message: "unused var", file: "src/a.ts", line: 1 });
export const lintB = makeFinding({ source: "lint", message: "missing semicolon", file: "src/b.ts", line: 5 });
export const typecheckC = makeFinding({
  source: "typecheck",
  message: "TS2304: Cannot find name",
  file: "src/c.ts",
  line: 3,
});

export function makeCtx(): FixCycleContext {
  const config = makeNaxConfig();
  return {
    runtime: {
      configLoader: { current: () => config },
      agentManager: makeMockAgentManager(),
      sessionManager: {} as FixCycleContext["runtime"]["sessionManager"],
      packages: { resolve: () => ({ select: () => config }) } as unknown as FixCycleContext["runtime"]["packages"],
      projectDir: "/tmp/test",
    } as unknown as FixCycleContext["runtime"],
    packageView: { select: () => config } as unknown as FixCycleContext["packageView"],
    packageDir: "/tmp/test",
    storyId: "story-1",
    agentName: "claude",
  };
}

export const noopOp = {
  name: "noop-op",
  kind: "complete" as const,
  stage: "verify" as const,
  config: [],
  build: () => "",
  parse: () => null,
  jsonMode: false,
} as unknown as FixStrategy<Finding, unknown, unknown>["fixOp"];

export function makeStrategy(
  overrides: Partial<FixStrategy<Finding, unknown, unknown>> & Pick<FixStrategy<Finding, unknown, unknown>, "name">,
): FixStrategy<Finding, unknown, unknown> {
  return {
    appliesTo: () => true,
    fixOp: noopOp,
    buildInput: () => ({}),
    maxAttempts: 3,
    coRun: "co-run-sequential",
    ...overrides,
  };
}

export function makeCycle(
  findings: Finding[],
  strategies: FixStrategy<Finding, unknown, unknown>[],
  validateFn: FixCycle<Finding>["validate"],
  overrides?: Partial<FixCycle<Finding>>,
): FixCycle<Finding> {
  return {
    findings,
    iterations: [],
    strategies,
    validate: validateFn,
    config: { maxAttemptsTotal: 10, validatorRetries: 1 },
    ...overrides,
  };
}

/**
 * `callOp` stub backed by bun's `mock()`, typed as the thing it stands in for.
 *
 * `CallOpFn` is generic (`<I, O, C>(ctx, op: Operation<I, O, C>, input: I) =>
 * Promise<O>`), so no concrete function can satisfy it — `src/findings/cycle.ts`
 * casts its own `_callOp` for the same reason. The cast lives here once instead
 * of at all 65 call sites (#1514 phase 1b); the returned value is still a bun
 * mock, so `toHaveBeenCalledTimes` and `.mock.calls` work unchanged.
 *
 * Pass a value for a fixed result, or a handler `({ ctx, opName, input })` when
 * the stub has to branch on the operation or record a dispatch.
 *
 * Prefer {@link makeCallOpSpy} in new tests — it records ctx and input
 * readably, without reaching into bun's mock internals.
 */
export type CallOpCall = { ctx: FixCycleContext; opName: string; input: unknown };
export type CallOpHandler = (call: CallOpCall) => unknown;

// Overloaded, not a union parameter: `unknown | Handler` collapses to `unknown`
// and the handler's `{ opName }` would infer as `any`.
export function makeCallOpMock(handler: CallOpHandler): CallOpFn & ReturnType<typeof mock>;
export function makeCallOpMock(returnValue?: unknown): CallOpFn & ReturnType<typeof mock>;
export function makeCallOpMock(result: unknown = {}): CallOpFn & ReturnType<typeof mock> {
  const fn =
    typeof result === "function"
      ? mock(async (ctx: FixCycleContext, op: { name: string }, input: unknown) =>
          (result as CallOpHandler)({
            ctx,
            opName: op.name,
            input,
          }),
        )
      : mock(async () => result);
  return fn as unknown as CallOpFn & ReturnType<typeof mock>;
}

/**
 * Typed `callOp` stub that records each dispatch's context and input.
 *
 * Prefer this over `makeCallOpMock()` in new tests: it satisfies `CallOpFn`
 * directly, so call sites need no type assertion at all, and the
 * recorded `ctx` is readable without reaching into bun's mock internals.
 */
export function makeCallOpSpy(returnValue: unknown = {}): {
  fn: CallOpFn;
  calls: Array<{ ctx: FixCycleContext; opName: string; input: unknown }>;
} {
  const calls: Array<{ ctx: FixCycleContext; opName: string; input: unknown }> = [];
  const fn: CallOpFn = async (ctx, op, input) => {
    calls.push({ ctx, opName: op.name, input });
    return returnValue as never;
  };
  return { fn, calls };
}
