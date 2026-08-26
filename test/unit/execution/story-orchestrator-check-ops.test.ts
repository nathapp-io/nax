/**
 * StoryOrchestratorBuilder — Check Ops Tests
 *
 * Tests for the new check-phase builder methods (US-003):
 * - AC7: lint-check, typecheck-check, verify-scoped appear in CANONICAL_ORDER
 * - AC8: addLintCheck, addTypecheckCheck, addVerifyScoped accept OrchestratorSlot overload
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime } from "@test/helpers";
import { pickSelector } from "@/config";
import { StoryOrchestratorBuilder } from "@/execution";
import type { CallContext, DeterministicOperation, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const testSel = pickSelector("test-orchestrator-sel", "execution");

/** The op fixtures' config slice, derived from the selector so the two cannot drift. */
type TestOpConfig = ReturnType<(typeof testSel)["select"]>;

const mockImplementerOp: RunOperation<{ code: string }, { success: boolean }, TestOpConfig> = {
  kind: "run",
  name: "mock-implementer",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "impl", overridable: false },
    task: { id: "t", content: "", overridable: false },
  }),
  parse: () => ({ success: true }),
};

function makeCheckOp(
  name: string,
): DeterministicOperation<
  { workdir: string; storyId: string },
  { success: boolean; findings: never[]; durationMs: number },
  TestOpConfig
> {
  return {
    kind: "deterministic",
    name,
    stage: "review",
    config: testSel,
    async execute() {
      return { success: true, findings: [], durationMs: 0 };
    },
  };
}

let runtime: NaxRuntime;

function makeCtx(): CallContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-003",
  };
}

afterEach(async () => {
  await runtime?.close();
});

describe("StoryOrchestratorBuilder — AC7: CANONICAL_ORDER includes new check phases", () => {
  test("AC7: phaseNames includes lint-check when addLintCheck is called", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addLintCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    expect(plan.phaseNames()).toContain("lint-check");
  });

  test("AC7: phaseNames includes typecheck-check when addTypecheckCheck is called", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addTypecheckCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    expect(plan.phaseNames()).toContain("typecheck-check");
  });

  test("AC7: phaseNames includes verify-scoped when addVerifyScoped is called", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addVerifyScoped({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    expect(plan.phaseNames()).toContain("verify-scoped");
  });

  test("AC7: verify-scoped appears before lint-check in CANONICAL_ORDER", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addVerifyScoped({ workdir: "/tmp", storyId: "US-003" })
      .addLintCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    const names = plan.phaseNames();
    expect(names.indexOf("verify-scoped")).toBeLessThan(names.indexOf("lint-check"));
  });

  test("AC7: lint-check appears before typecheck-check in CANONICAL_ORDER", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addLintCheck({ workdir: "/tmp", storyId: "US-003" })
      .addTypecheckCheck({ workdir: "/tmp", storyId: "US-003" })
      .build(ctx);
    const names = plan.phaseNames();
    expect(names.indexOf("lint-check")).toBeLessThan(names.indexOf("typecheck-check"));
  });

  test("lint-check not in phaseNames when addLintCheck not called", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .build(ctx);
    expect(plan.phaseNames()).not.toContain("lint-check");
  });

  test("typecheck-check not in phaseNames when addTypecheckCheck not called", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .build(ctx);
    expect(plan.phaseNames()).not.toContain("typecheck-check");
  });

  test("verify-scoped not in phaseNames when addVerifyScoped not called", () => {
    const ctx = makeCtx();
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .build(ctx);
    expect(plan.phaseNames()).not.toContain("verify-scoped");
  });
});

describe("StoryOrchestratorBuilder — AC8: builder methods accept OrchestratorSlot overload", () => {
  test("AC8: addLintCheck accepts OrchestratorSlot with custom op", () => {
    const ctx = makeCtx();
    const customOp = makeCheckOp("custom-lint");
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addLintCheck({ op: customOp, input: { workdir: "/tmp", storyId: "US-003" } })
      .build(ctx);
    expect(plan.phaseNames()).toContain("custom-lint");
  });

  test("AC8: addTypecheckCheck accepts OrchestratorSlot with custom op", () => {
    const ctx = makeCtx();
    const customOp = makeCheckOp("custom-typecheck");
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addTypecheckCheck({ op: customOp, input: { workdir: "/tmp", storyId: "US-003" } })
      .build(ctx);
    expect(plan.phaseNames()).toContain("custom-typecheck");
  });

  test("AC8: addVerifyScoped accepts OrchestratorSlot with custom op", () => {
    const ctx = makeCtx();
    const customOp = makeCheckOp("custom-verify-scoped");
    const plan = new StoryOrchestratorBuilder()
      .addImplementer({ op: mockImplementerOp, input: { code: "" } })
      .addVerifyScoped({ op: customOp, input: { workdir: "/tmp", storyId: "US-003" } })
      .build(ctx);
    expect(plan.phaseNames()).toContain("custom-verify-scoped");
  });
});
