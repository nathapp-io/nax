/**
 * Integration tests: TDD full-suite gate operation behavior (AC#7 migration)
 *
 * File: tdd-flow-rectification.test.ts
 * Covers:
 * - AC3: TDD rectification gate invokes runRectificationLoop via deps injection
 *
 * Migrated from direct legacy-gate calls to fullSuiteGateOp + _fullSuiteGateDeps.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { _fullSuiteGateDeps, fullSuiteGateOp } from "../../../../src/operations/full-suite-gate";
import type { FullSuiteGateDeps, FullSuiteGateInput } from "../../../../src/operations/full-suite-gate";
import type { UserStory } from "../../../../src/prd";
import { makeStory, makeTestRuntime } from "../../../helpers";

const ACP_WORKDIR = `/tmp/nax-acp-test-${randomUUID()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Dep save/restore
// ─────────────────────────────────────────────────────────────────────────────

let origRunTests: typeof _fullSuiteGateDeps.runTests;
let origRunRectificationLoop: typeof _fullSuiteGateDeps.runRectificationLoop;

beforeEach(() => {
  origRunTests = _fullSuiteGateDeps.runTests;
  origRunRectificationLoop = _fullSuiteGateDeps.runRectificationLoop;
});

afterEach(() => {
  _fullSuiteGateDeps.runTests = origRunTests;
  _fullSuiteGateDeps.runRectificationLoop = origRunRectificationLoop;
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<FullSuiteGateInput> = {}): FullSuiteGateInput {
  return {
    story: makeStory({ id: "ACP-007-test" }),
    workdir: ACP_WORKDIR,
    rectificationEnabled: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3: TDD rectification gate works with fullSuiteGateOp
// ─────────────────────────────────────────────────────────────────────────────

describe("fullSuiteGateOp via _fullSuiteGateDeps", () => {
  function makeCtx() {
    const runtime = makeTestRuntime();
    return {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: ACP_WORKDIR,
      agentName: "claude",
    };
  }

  test("returns success=true when tests pass (rectification disabled)", async () => {
    _fullSuiteGateDeps.runTests = mock(async () => ({ passed: true, failed: 0, output: "" }));

    // biome-ignore lint/suspicious/noExplicitAny: test mock ctx
    const result = await fullSuiteGateOp.execute(makeInput(), makeCtx() as any);

    expect(result.success).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  test("returns failed-no-rectification when tests fail and rectification disabled", async () => {
    _fullSuiteGateDeps.runTests = mock(async () => ({ passed: false, failed: 2, output: "2 failures" }));

    // biome-ignore lint/suspicious/noExplicitAny: test mock ctx
    const result = await fullSuiteGateOp.execute(makeInput({ rectificationEnabled: false }), makeCtx() as any);

    expect(result.success).toBe(false);
    expect(result.status).toBe("failed-no-rectification");
  });

  test("invokes runRectificationLoop when tests fail and rectification enabled", async () => {
    let rectCalled = false;
    _fullSuiteGateDeps.runTests = mock(async () => ({ passed: false, failed: 2, output: "2 failures" }));
    _fullSuiteGateDeps.runRectificationLoop = mock(async () => {
      rectCalled = true;
      return { exhausted: false, attempts: 1, fixedAll: true };
    });

    // biome-ignore lint/suspicious/noExplicitAny: test mock ctx
    const result = await fullSuiteGateOp.execute(makeInput({ rectificationEnabled: true }), makeCtx() as any);

    expect(rectCalled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.status).toBe("passed");
  });

  test("returns rectification-exhausted when loop exhausts", async () => {
    _fullSuiteGateDeps.runTests = mock(async () => ({ passed: false, failed: 3, output: "failures" }));
    _fullSuiteGateDeps.runRectificationLoop = mock(async () => ({
      exhausted: true,
      attempts: 2,
      fixedAll: false,
    }));

    // biome-ignore lint/suspicious/noExplicitAny: test mock ctx
    const result = await fullSuiteGateOp.execute(makeInput({ rectificationEnabled: true }), makeCtx() as any);

    expect(result.success).toBe(false);
    expect(result.status).toBe("rectification-exhausted");
    expect(result.attempts).toBe(2);
  });
});
