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
import type { PlanRefineInput } from "@/operations";
import type { HopBodyContext } from "@/operations/types";
import { PlanPromptBuilder } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import { makePRD, makeStory, makeTestRuntime, opSelector, withWarnSpy } from "@test/helpers";

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
  return makePRD({
    feature: "f",
    branchName: "feat/f",
    ...(outOfScope ? { outOfScope } : {}),
    userStories: [
      makeStory({
        acceptanceCriteria: ["When run with no args, then exit_code == 2 and stderr contains 'invalid config'"],
        routing: { complexity: "simple", testStrategy: "no-test", noTestJustification: "t", reasoning: "t" },
      }),
    ],
  });
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
    const ctx: HopBodyContext<PlanRefineInput> = {
      input: {
        specContent: SPEC,
        codebaseContext: "",
        featureName: "f",
        branchName: "feat/f",
        outputPath: "/tmp/p.json",
      },
      send,
      sendWithParseRetry,
    };
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
      config: view.select(opSelector(planRefineOp.config)),
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
      const result = await planRefineOp.verify!(makePrd(), input as never, makeVerifyCtx() as never);

      expect(result?.outOfScope).toEqual(["An interactive Ink TUI", "Per-story checkpoints"]);
      const warn = warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("out-of-scope"));
      expect(warn).toBeDefined();
      expect((warn?.[2] as Record<string, unknown> | undefined)?.missingCount).toBe(2);
    });
  });

  test("leaves a fully preserved list untouched and does not warn", async () => {
    await withWarnSpy(async (warnSpy) => {
      const preserved = ["An interactive Ink TUI", "Per-story checkpoints"];
      const result = await planRefineOp.verify!(makePrd(preserved), input as never, makeVerifyCtx() as never);

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

describe("planRefineOp.verify — story-local hoist demotion (#1446)", () => {
  const HOIST_SPEC = [
    "## Out of Scope",
    "",
    "- An interactive Ink TUI",
    "",
    "## Acceptance Criteria",
    "",
    "### US-001 — Import endpoint",
    "",
    "**Out of scope:** body-size limits on the import endpoint, deferred to arc 3.",
  ].join("\n");

  function makeVerifyCtx() {
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    return {
      packageView: view,
      config: view.select(opSelector(planRefineOp.config)),
      readFile: async (_p: string) => null,
      fileExists: async (_p: string) => false,
    };
  }

  const input = {
    specContent: HOIST_SPEC,
    codebaseContext: "",
    featureName: "f",
    branchName: "feat/f",
    outputPath: "/tmp/p.json",
  };

  test("demotes a hoisted story-local block onto its owning story, and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const hoisted = makePrd([
        "An interactive Ink TUI",
        "body-size limits on the import endpoint, deferred to arc 3.",
      ]);

      const result = await planRefineOp.verify!(hoisted, input as never, makeVerifyCtx() as never);

      expect(result?.outOfScope).toEqual(["An interactive Ink TUI"]);
      expect(result?.userStories[0].outOfScope).toEqual([
        "body-size limits on the import endpoint, deferred to arc 3.",
      ]);
      const warn = warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("hoisted"));
      expect(warn).toBeDefined();
      expect((warn?.[2] as Record<string, unknown> | undefined)?.hoistedCount).toBe(1);
    });
  });

  test("the demotion does not trip the backfill into restoring it at feature level", async () => {
    const hoisted = makePrd(["An interactive Ink TUI", "body-size limits on the import endpoint, deferred to arc 3."]);

    const result = await planRefineOp.verify!(hoisted, input as never, makeVerifyCtx() as never);

    expect(result?.outOfScope).not.toContain("body-size limits on the import endpoint, deferred to arc 3.");
  });
});
