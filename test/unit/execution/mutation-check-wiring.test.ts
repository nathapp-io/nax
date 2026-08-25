/**
 * Wire mutation-check into story-orchestrator phases and plan building — US-005.
 *
 * Acceptance criteria:
 *  AC1: CANONICAL_ORDER contains "mutation-check" at the index immediately following "full-suite-gate".
 *  AC2: PHASE_KIND_TO_STATE_KEY["mutation-check"] === "mutationCheck" AND InternalBuildState accepts a mutationCheck phase entry.
 *  AC3: STRICT_VERDICT_PHASE_NAMES.has("mutation-check") === false.
 *  AC4: addMutationCheck(input) registers mutationCheckOp so it runs after full-suite-gate when enabled.
 *  AC5: buildPlanForStrategy() includes "mutation-check" iff PlanInputs.mutationCheck is present.
 *  AC6: A mutation-check survivor with success:true does not short-circuit downstream verifier.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeMockPlanInputs, makeNaxConfig, makeStory, makeTestRuntime } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { MutationCheckConfig } from "@/config/selectors";
import {
  _storyOrchestratorDeps,
  buildPlanForStrategy,
  CANONICAL_ORDER,
  type InternalBuildState,
  PHASE_KIND_TO_STATE_KEY,
  STRICT_VERDICT_PHASE_NAMES,
  StoryOrchestratorBuilder,
} from "@/execution";
import type { CallContext, DeterministicOperation, MutationCheckInput, MutationCheckOutput } from "@/operations";
import { mutationCheckOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// AC1: CANONICAL_ORDER positions mutation-check immediately after full-suite-gate
// ─────────────────────────────────────────────────────────────────────────────

describe("AC1: CANONICAL_ORDER positions mutation-check after full-suite-gate", () => {
  test("CANONICAL_ORDER contains 'mutation-check'", () => {
    expect(CANONICAL_ORDER).toContain("mutation-check");
  });

  test("'mutation-check' is at the index immediately following 'full-suite-gate'", () => {
    const gateIdx = CANONICAL_ORDER.indexOf("full-suite-gate");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(CANONICAL_ORDER[gateIdx + 1]).toBe("mutation-check");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: PHASE_KIND_TO_STATE_KEY + InternalBuildState registration
// ─────────────────────────────────────────────────────────────────────────────

describe("AC2: PHASE_KIND_TO_STATE_KEY + InternalBuildState accept mutation-check", () => {
  test("PHASE_KIND_TO_STATE_KEY['mutation-check'] === 'mutationCheck'", () => {
    expect(PHASE_KIND_TO_STATE_KEY["mutation-check"]).toBe("mutationCheck");
  });

  test("InternalBuildState accepts a mutationCheck phase entry", () => {
    const state: InternalBuildState = {
      mutationCheck: { kind: "mutation-check", slot: { op: {} as any, input: {} } },
    };
    expect(state.mutationCheck).toBeDefined();
    expect(state.mutationCheck?.kind).toBe("mutation-check");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: STRICT_VERDICT_PHASE_NAMES excludes mutation-check
// ─────────────────────────────────────────────────────────────────────────────

describe("AC3: STRICT_VERDICT_PHASE_NAMES excludes mutation-check", () => {
  test("STRICT_VERDICT_PHASE_NAMES does NOT include 'mutation-check'", () => {
    expect(STRICT_VERDICT_PHASE_NAMES.has("mutation-check")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: builder.addMutationCheck + spied mutationCheckOp runs after full-suite-gate
// ─────────────────────────────────────────────────────────────────────────────

function makeMutationCheckOp(result: {
  success: true;
  survivors?: readonly { file: string }[];
}): DeterministicOperation<MutationCheckInput, MutationCheckOutput, MutationCheckConfig> {
  const survivors = (result.survivors ?? []).map((s) => ({
    file: s.file,
    line: 1,
    before: "before",
    after: "after",
    operatorId: "test-operator",
    outcome: "survived" as const,
  }));
  return {
    kind: "deterministic",
    name: "mutation-check",
    stage: "verify",
    config: (() => DEFAULT_CONFIG) as any,
    execute: async () => ({
      success: true,
      survivors,
      outcomes: { killed: 0, survived: survivors.length, errored: 0 },
      candidates: survivors.length,
      checked: true,
    }),
  };
}

function makeDeterministicOp(
  name: string,
  result: { success: boolean; findings?: unknown[] },
): DeterministicOperation<unknown, unknown, MutationCheckConfig> {
  return {
    kind: "deterministic",
    name,
    stage: "verify",
    config: (() => DEFAULT_CONFIG) as any,
    execute: async () => ({ ...result, estimatedCostUsd: 0 }),
  };
}

describe("AC4: builder.addMutationCheck + plan run", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
  });

  test("addMutationCheck input overload registers the built-in mutationCheckOp for dispatch", async () => {
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const calls: { name: string; op: unknown }[] = [];
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      calls.push({ name: op.name, op });
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-005",
      } as any;
      const mutationCheckInput: MutationCheckInput = {
        story: makeStory({ id: "US-005" }),
        workdir: "/tmp",
        storyId: "US-005",
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":(exclude)test/**/*.test.ts"],
          testDirs: ["test/unit", "test/integration"],
          resolution: "detected",
        },
      };
      const gateOp = makeDeterministicOp("full-suite-gate", { success: true });

      const plan = new StoryOrchestratorBuilder()
        .addImplementer({
          op: {
            kind: "run",
            name: "mock-implementer",
            stage: "run",
            config: (() => DEFAULT_CONFIG) as any,
            session: { role: "implementer", lifetime: "warm" },
            build: () => ({
              role: { id: "r", content: "", overridable: false },
              task: { id: "t", content: "", overridable: false },
            }),
            parse: () => ({ success: true }),
          },
          input: { code: "" },
        })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-005" }) as any, workdir: "/tmp" } })
        .addMutationCheck(mutationCheckInput)
        .build(ctx);

      await plan.run();

      const mutationCall = calls.find((c) => c.name === "mutation-check");
      expect(mutationCall).toBeDefined();
      // Input overload must wire the built-in mutationCheckOp, not a fresh stub.
      expect(mutationCall?.op).toBe(mutationCheckOp);
      const gateIdx = calls.findIndex((c) => c.name === "full-suite-gate");
      const mutationIdx = calls.findIndex((c) => c.name === "mutation-check");
      expect(mutationIdx).toBe(gateIdx + 1);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });

  test("addMutationCheck slot overload dispatches a spied mutationCheckOp after full-suite-gate", async () => {
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const calls: string[] = [];
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      calls.push(op.name);
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-005",
      } as any;
      const gateOp = makeDeterministicOp("full-suite-gate", { success: true });
      const spiedMutationOp = makeMutationCheckOp({ success: true, survivors: [] });
      const mutationCheckInput: MutationCheckInput = {
        story: makeStory({ id: "US-005" }),
        workdir: "/tmp",
        storyId: "US-005",
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":(exclude)test/**/*.test.ts"],
          testDirs: ["test/unit", "test/integration"],
          resolution: "detected",
        },
      };

      const plan = new StoryOrchestratorBuilder()
        .addImplementer({
          op: {
            kind: "run",
            name: "mock-implementer",
            stage: "run",
            config: (() => DEFAULT_CONFIG) as any,
            session: { role: "implementer", lifetime: "warm" },
            build: () => ({
              role: { id: "r", content: "", overridable: false },
              task: { id: "t", content: "", overridable: false },
            }),
            parse: () => ({ success: true }),
          },
          input: { code: "" },
        })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-005" }) as any, workdir: "/tmp" } })
        .addMutationCheck({ op: spiedMutationOp, input: mutationCheckInput })
        .build(ctx);

      await plan.run();

      const mutationIdx = calls.indexOf("mutation-check");
      const gateIdx = calls.indexOf("full-suite-gate");
      expect(mutationIdx).toBeGreaterThanOrEqual(0);
      expect(gateIdx).toBeGreaterThanOrEqual(0);
      expect(mutationIdx).toBe(gateIdx + 1);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: buildPlanForStrategy wires mutation-check iff PlanInputs.mutationCheck present
// ─────────────────────────────────────────────────────────────────────────────

describe("AC5: buildPlanForStrategy wires mutation-check from PlanInputs", () => {
  test("PlanInputs.mutationCheck defined → plan contains 'mutation-check' phase", async () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp" } as any,
      verifier: { story } as any,
      mutationCheck: {
        story,
        workdir: "/tmp",
        storyId: story.id,
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":(exclude)test/**/*.test.ts"],
          testDirs: ["test/unit", "test/integration"],
          resolution: "detected",
        },
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).toContain("mutation-check");
  });

  test("PlanInputs.mutationCheck undefined → plan does NOT contain 'mutation-check' phase", async () => {
    const story = makeStory();
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp" } as any,
      verifier: { story } as any,
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    expect(plan.phaseNames()).not.toContain("mutation-check");
  });

  test("mutation-check phase appears immediately after full-suite-gate in plan.phaseNames()", async () => {
    const story = makeStory({ attempts: 0 });
    const config = makeNaxConfig();
    const ctx = makeMockCallContext();
    const inputs = makeMockPlanInputs({
      story,
      testWriter: { story } as any,
      greenfieldGate: {
        story,
        workdir: "/tmp",
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":(exclude)test/**/*.test.ts"],
          testDirs: ["test/unit", "test/integration"],
          resolution: "detected",
        },
      } as any,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp" } as any,
      verifier: { story } as any,
      mutationCheck: {
        story,
        workdir: "/tmp",
        storyId: story.id,
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":(exclude)test/**/*.test.ts"],
          testDirs: ["test/unit", "test/integration"],
          resolution: "detected",
        },
      },
    });
    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const names = plan.phaseNames();
    const gateIdx = names.indexOf("full-suite-gate");
    expect(names[gateIdx + 1]).toBe("mutation-check");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: A survivor with success:true does not short-circuit downstream verifier
// ─────────────────────────────────────────────────────────────────────────────

describe("AC6: mutation-check survivor with success:true does not halt verifier", () => {
  let rt: NaxRuntime | undefined;
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
  });

  test("mutation-check output { success: true, survivors: [...] } does not block verifier", async () => {
    const config = makeNaxConfig();
    rt = makeTestRuntime({ config });

    const calls: string[] = [];
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = async (_ctx: any, op: any, input: any) => {
      calls.push(op.name);
      if (op.kind === "deterministic") return op.execute(input, _ctx);
      return { success: true, filesChanged: [], estimatedCostUsd: 0, durationMs: 0 };
    };

    try {
      const ctx: CallContext = {
        runtime: rt,
        packageView: rt.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-005",
      } as any;
      const gateOp = makeDeterministicOp("full-suite-gate", { success: true });
      const verOp = makeDeterministicOp("verifier", { success: true });
      const mutationOp = makeMutationCheckOp({ success: true, survivors: [{ file: "x.ts" }] });
      const mutationCheckInput: MutationCheckInput = {
        story: makeStory({ id: "US-005" }),
        workdir: "/tmp",
        storyId: "US-005",
        resolvedTestPatterns: {
          globs: ["test/**/*.test.ts"],
          regex: [/\.test\.ts$/],
          pathspec: [":(exclude)test/**/*.test.ts"],
          testDirs: ["test/unit", "test/integration"],
          resolution: "detected",
        },
      };

      const plan = new StoryOrchestratorBuilder()
        .addImplementer({
          op: {
            kind: "run",
            name: "mock-implementer",
            stage: "run",
            config: (() => DEFAULT_CONFIG) as any,
            session: { role: "implementer", lifetime: "warm" },
            build: () => ({
              role: { id: "r", content: "", overridable: false },
              task: { id: "t", content: "", overridable: false },
            }),
            parse: () => ({ success: true }),
          },
          input: { code: "" },
        })
        .addFullSuiteGate({ op: gateOp, input: { story: makeStory({ id: "US-005" }) as any, workdir: "/tmp" } })
        .addMutationCheck({ op: mutationOp, input: mutationCheckInput })
        .addVerifier({ op: verOp, input: { code: "" } })
        .build(ctx);

      await plan.run();

      const verIdx = calls.indexOf("verifier");
      const mutationIdx = calls.indexOf("mutation-check");
      expect(mutationIdx).toBeGreaterThanOrEqual(0);
      expect(verIdx).toBeGreaterThan(mutationIdx);
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: assemblePlanInputsFromCtx must populate mutationCheck when the
// config flag is enabled. The plan-inputs interface was extended but the
// pipeline-context assembly path is what actually wires the slot at runtime,
// so an unguarded extension leaves the feature dead in the real pipeline.
// ─────────────────────────────────────────────────────────────────────────────

describe("regression: assemblePlanInputsFromCtx populates mutationCheck", () => {
  test("enabled: mutationCheck input is populated from pipeline context", async () => {
    const { assemblePlanInputsFromCtx } = await import("@/execution");
    const ctx = {
      story: makeStory({ id: "US-005", title: "Test" }),
      config: makeNaxConfig({
        execution: {
          ...makeNaxConfig().execution,
          mutationCheck: { enabled: true, maxMutants: 3, timeoutSeconds: 60 },
        },
      }),
      workdir: "/tmp/repo",
      routing: { testStrategy: "three-session-tdd", agent: "claude" },
      prompt: "",
      featureContextMarkdown: "feat",
      constitution: { content: "" },
      prd: { feature: "f" },
      projectDir: "/tmp/proj",
      storyGitRef: "abc123",
    } as any;
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.mutationCheck).toBeDefined();
    expect(inputs.mutationCheck?.storyId).toBe("US-005");
    expect(inputs.mutationCheck?.storyGitRef).toBe("abc123");
    expect(inputs.mutationCheck?.repoRoot).toBe("/tmp/proj");
  });

  test("disabled: mutationCheck input remains undefined", async () => {
    const { assemblePlanInputsFromCtx } = await import("@/execution");
    const ctx = {
      story: makeStory({ id: "US-005", title: "Test" }),
      config: makeNaxConfig(),
      workdir: "/tmp/repo",
      routing: { testStrategy: "three-session-tdd", agent: "claude" },
      prompt: "",
      featureContextMarkdown: "feat",
      constitution: { content: "" },
      prd: { feature: "f" },
      projectDir: "/tmp/proj",
    } as any;
    const inputs = await assemblePlanInputsFromCtx(ctx);
    expect(inputs.mutationCheck).toBeUndefined();
  });
});
