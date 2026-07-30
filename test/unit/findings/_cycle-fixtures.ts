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
import { makeMockAgentManager, makeNaxConfig } from "@test/helpers";

export function makeFinding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return { severity: "error", category: "test", ...overrides };
}

export const lintA = makeFinding({ source: "lint", message: "unused var", file: "src/a.ts", line: 1 });
export const lintB = makeFinding({ source: "lint", message: "missing semicolon", file: "src/b.ts", line: 5 });
export const typecheckC = makeFinding({ source: "typecheck", message: "TS2304: Cannot find name", file: "src/c.ts", line: 3 });

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

export function makeCallOpMock(returnValue: unknown = {}): ReturnType<typeof mock> {
  return mock(async () => returnValue);
}
