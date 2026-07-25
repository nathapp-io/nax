/**
 * Out-of-scope fidelity in refine mode.
 *
 * Split from plan-refine.test.ts (already at the 800-line ceiling) per
 * .claude/rules/test-architecture.md — one concern per file.
 *
 * Covers the two layers that keep a spec's feature-level exclusions alive:
 * the hopBody self-heal turn (asks the model to restore them in its own
 * wording) and the verify backfill (guarantees they exist regardless).
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { _planRefineDeps, planRefineOp } from "@/operations";
import { PlanPromptBuilder } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime, withWarnSpy } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];
const origReadFile = _planRefineDeps.readFile;

afterEach(async () => {
  mock.restore();
  _planRefineDeps.readFile = origReadFile;
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

const SPEC = "## Out of Scope\n\n- An interactive Ink TUI\n- Per-story checkpoints\n";

function makePrd(outOfScope?: string[]) {
  return {
    project: "test-project",
    feature: "f",
    branchName: "feat/f",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...(outOfScope ? { outOfScope } : {}),
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "Test description",
        acceptanceCriteria: ["When run with no args, then exit_code == 2 and stderr contains 'invalid config'"],
        contextFiles: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "t", reasoning: "t" },
        escalations: [],
        attempts: 0,
      },
    ],
  };
}

describe("planRefineOp.hopBody — out-of-scope self-heal turn", () => {
  function turn(output: string, cost: number) {
    return { output, estimatedCostUsd: cost, internalRoundTrips: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
  }

  function makeCtx() {
    const sendWithParseRetry = mock(async () => turn("draft", 1));
    let sendCount = 0;
    const send = mock(async (_p: string) => {
      sendCount += 1;
      return turn(sendCount === 1 ? "refined" : "repaired", 2);
    });
    const ctx = {
      input: {
        specContent: SPEC,
        codebaseContext: "",
        featureName: "f",
        branchName: "feat/f",
        outputPath: "/tmp/p.json",
      },
      send,
      sendWithParseRetry,
    } as unknown as Parameters<NonNullable<typeof planRefineOp.hopBody>>[1];
    return { ctx, send };
  }

  test("fires one repair turn listing every dropped exclusion", async () => {
    _planRefineDeps.readFile = async () => JSON.stringify(makePrd());
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildOutOfScopeRepair").mockReturnValue("REPAIR-PROMPT");
    const { ctx, send } = makeCtx();

    const result = await planRefineOp.hopBody!("init", ctx);

    expect(repairSpy).toHaveBeenCalledTimes(1);
    expect(repairSpy.mock.calls[0][0]).toEqual(["An interactive Ink TUI", "Per-story checkpoints"]);
    expect(send).toHaveBeenCalledTimes(2); // refine + repair
    expect(send.mock.calls[1][0]).toBe("REPAIR-PROMPT");
    expect(result.output).toBe("repaired");
  });

  test("no repair turn when the written PRD preserved every exclusion", async () => {
    _planRefineDeps.readFile = async () =>
      JSON.stringify(makePrd(["An interactive Ink TUI", "Per-story checkpoints — deferred"]));
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildOutOfScopeRepair");
    const { ctx, send } = makeCtx();

    const result = await planRefineOp.hopBody!("init", ctx);

    expect(repairSpy).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.output).toBe("refined");
  });

  test("no repair turn when the PRD file is absent or unparseable", async () => {
    _planRefineDeps.readFile = async () => null;
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildOutOfScopeRepair");
    const { ctx, send } = makeCtx();

    await planRefineOp.hopBody!("init", ctx);

    expect(repairSpy).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("planRefineOp.verify — out-of-scope backfill", () => {
  function makeVerifyCtx() {
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    return {
      packageView: view,
      config: view.select(planRefineOp.config),
      readFile: async (_p: string) => null,
      fileExists: async (_p: string) => false,
    };
  }

  const input = {
    specContent: SPEC,
    codebaseContext: "",
    featureName: "f",
    branchName: "feat/f",
    outputPath: "/tmp/p.json",
  };

  test("restores exclusions the repair turn still missed, and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const result = await planRefineOp.verify!(makePrd() as never, input as never, makeVerifyCtx() as never);

      expect(result?.outOfScope).toEqual(["An interactive Ink TUI", "Per-story checkpoints"]);
      const warn = warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("out-of-scope"));
      expect(warn).toBeDefined();
      expect((warn?.[2] as Record<string, unknown>).missingCount).toBe(2);
    });
  });

  test("leaves a fully preserved list untouched and does not warn", async () => {
    await withWarnSpy(async (warnSpy) => {
      const preserved = ["An interactive Ink TUI", "Per-story checkpoints"];
      const result = await planRefineOp.verify!(makePrd(preserved) as never, input as never, makeVerifyCtx() as never);

      expect(result?.outOfScope).toEqual(preserved);
      expect(warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("out-of-scope"))).toBeUndefined();
    });
  });

  test("adds no field when the spec declares no exclusions", async () => {
    const noScope = { ...input, specContent: "# Feature\n\n## Design\n- build it\n" };
    const result = await planRefineOp.verify!(makePrd() as never, noScope as never, makeVerifyCtx() as never);

    expect(result?.outOfScope).toBeUndefined();
  });
});
