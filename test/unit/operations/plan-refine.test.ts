import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { _planRefineDeps, callOp, planRefineOp } from "@/operations";
import type { AgentRunRequest } from "@/agents/manager-types";
import { PlanPromptBuilder } from "@/prompts";
import { planInteractiveOp } from "@/operations";
import type { VerifyContext } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime, withTempDir } from "@test/helpers";
import type { HopBodyContext } from "@/operations/types";

const createdRuntimes: NaxRuntime[] = [];

const origReadFile = _planRefineDeps.readFile;
afterEach(async () => {
  mock.restore();
  _planRefineDeps.readFile = origReadFile;
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

function makeValidPrd(feature: string, branchName: string) {
  return {
    project: "test-project",
    feature,
    analysis: "test analysis",
    branchName,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "Test description",
        acceptanceCriteria: [
          "CliRunner().invoke(app, ['test']) returns exit_code == 2 and stderr contains 'invalid config'",
        ],
        contextFiles: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        routing: {
          complexity: "simple",
          testStrategy: "no-test",
          noTestJustification: "test",
          reasoning: "test",
        },
        escalations: [],
        attempts: 0,
      },
    ],
  };
}

describe("planRefineOp export and identity", () => {
  test("exports planRefineOp from the operations barrel", async () => {
    const mod = await import("@/operations");
    expect(mod).toHaveProperty("planRefineOp");
  });

  test("has kind run and name plan-refine", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    expect(planRefineOp.kind).toBe("run");
    expect(planRefineOp.name).toBe("plan-refine");
  });

  test("uses the plan-refine session role with a fresh lifetime", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    expect(planRefineOp.session.role).toBe("plan-refine");
    expect(planRefineOp.session.lifetime).toBe("fresh");
  });

  test("defines config and retry for the two-turn refine flow", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    expect(planRefineOp.config).toBeDefined();
    expect(planRefineOp.retry).toBeDefined();
    expect(typeof planRefineOp.retry).toBe("function");
  });

  test("defines fileOutput so callOp can substitute written PRD content", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const outputPath = "/tmp/plan-refine-prd.json";
    expect(planRefineOp.fileOutput?.({ outputPath } as never)).toBe(outputPath);
  });
});

describe("planRefineOp.build()", () => {
  test("returns a ComposeInput whose task content includes the feature name", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };

    const result = planRefineOp.build(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/prd.json",
      },
      ctx,
    );

    expect(result.task.content).toContain("checkout-flow");
  });
});

describe("planRefineOp.hopBody()", () => {
  test("calls sendWithParseRetry for the draft turn and send for the refine turn", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const initialPrompt = "draft prompt";
    const refinePrompt = "refine prompt";

    const sendWithParseRetry = mock(async (_prompt: string) => ({
      output: "draft-confirmation",
      estimatedCostUsd: 1.25,
      internalRoundTrips: 1,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    }));
    const send = mock(async (_prompt: string) => ({
      output: "refined-confirmation",
      estimatedCostUsd: 2.75,
      internalRoundTrips: 2,
      tokenUsage: { inputTokens: 2, outputTokens: 2 },
    }));
    const buildRefineContinuationSpy = spyOn(PlanPromptBuilder.prototype, "buildRefineContinuation").mockReturnValue(
      refinePrompt,
    );
    // No verbatim ACs in this spec → no self-heal turn. Stub disk to avoid real I/O.
    _planRefineDeps.readFile = async () => null;

    const ctx: HopBodyContext<{
      specContent: string;
      codebaseContext: string;
      featureName: string;
      branchName: string;
      outputPath: string;
    }> = {
      input: {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/plan-refine-prd.json",
      },
      send,
      sendWithParseRetry,
    };

    const result = await planRefineOp.hopBody(initialPrompt, ctx);

    expect(sendWithParseRetry).toHaveBeenCalledTimes(1);
    expect(sendWithParseRetry).toHaveBeenCalledWith(initialPrompt);
    expect(send).toHaveBeenCalledTimes(1);
    expect(buildRefineContinuationSpy).toHaveBeenCalledTimes(1);
    expect(buildRefineContinuationSpy).toHaveBeenCalledWith("/tmp/plan-refine-prd.json");
    expect(send).toHaveBeenCalledWith(refinePrompt);
    expect(result.output).toBe("refined-confirmation");
    expect(result.estimatedCostUsd).toBe(4);
  });

  test("callOp parses the rewritten PRD file after the refine turn instead of the chat confirmation", async () => {
    await withTempDir(async (tempDir) => {
      const outputPath = join(tempDir, "prd.json");
      const turn1Prd = makeValidPrd("checkout-flow", "feat/checkout");
      const turn2Prd = {
        ...makeValidPrd("checkout-flow", "feat/checkout"),
        analysis: "refined analysis",
      };

      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req: AgentRunRequest) => {
          const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
          return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
        },
        runAsSessionFn: async (_agentName, _handle, prompt) => {
          if (prompt.includes("You are drafting a PRD")) {
            await Bun.write(outputPath, JSON.stringify(turn1Prd));
            return {
              output: "draft written",
              estimatedCostUsd: 1,
              internalRoundTrips: 1,
              tokenUsage: { inputTokens: 1, outputTokens: 1 },
            };
          }

          await Bun.write(outputPath, JSON.stringify(turn2Prd));
          return {
            output: "refinement complete",
            estimatedCostUsd: 2,
            internalRoundTrips: 1,
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      });

      const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
      createdRuntimes.push(runtime);

      const result = await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: tempDir,
          agentName: runtime.agentManager.getDefault(),
          storyId: "checkout-flow",
          featureName: "checkout-flow",
        },
        (await import("@/operations")).planRefineOp,
        {
          specContent: "Build a checkout flow",
          codebaseContext: "Existing app context",
          featureName: "checkout-flow",
          branchName: "feat/checkout",
          outputPath,
        },
      );

      expect(result.analysis).toBe("refined analysis");
    });
  });

  test("callOp falls back to recover when the refine turn does not rewrite the PRD file", async () => {
    await withTempDir(async (tempDir) => {
      const outputPath = join(tempDir, "prd.json");
      const turn1Prd = {
        ...makeValidPrd("checkout-flow", "feat/checkout"),
        analysis: "draft analysis",
      };

      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async (req: AgentRunRequest) => {
          const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
          return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
        },
        runAsSessionFn: async (_agentName, _handle, prompt) => {
          if (prompt.includes("You are drafting a PRD")) {
            await Bun.write(outputPath, JSON.stringify(turn1Prd));
            return {
              output: "draft written",
              estimatedCostUsd: 1,
              internalRoundTrips: 1,
              tokenUsage: { inputTokens: 1, outputTokens: 1 },
            };
          }

          return {
            output: "refinement complete",
            estimatedCostUsd: 2,
            internalRoundTrips: 1,
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      });

      const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
      createdRuntimes.push(runtime);

      const result = await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: tempDir,
          agentName: runtime.agentManager.getDefault(),
          storyId: "checkout-flow",
          featureName: "checkout-flow",
        },
        (await import("@/operations")).planRefineOp,
        {
          specContent: "Build a checkout flow",
          codebaseContext: "Existing app context",
          featureName: "checkout-flow",
          branchName: "feat/checkout",
          outputPath,
        },
      );

      expect(result.analysis).toBe("draft analysis");
    });
  });
});

async function withWarnSpy<T>(fn: (warnSpy: ReturnType<typeof spyOn>) => Promise<T>): Promise<T> {
  const { resetLogger, initLogger } = await import("@/logger");
  resetLogger();
  const warnSpy = spyOn(initLogger({ level: "silent" }), "warn");
  try {
    return await fn(warnSpy);
  } finally {
    warnSpy.mockRestore();
    resetLogger();
  }
}

function verbatimWarn(warnSpy: ReturnType<typeof spyOn>) {
  return warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("[verbatim]"));
}

describe("planRefineOp — warn-and-continue when self-heal still drops a verbatim AC", () => {
  test("callOp returns the PRD and warns (does not fail) after the repair turn still misses", async () => {
    await withWarnSpy(async (warnSpy) => {
      await withTempDir(async (tempDir) => {
        const outputPath = join(tempDir, "prd.json");
        // Every turn (draft, refine, repair) writes a structurally valid PRD that
        // never contains the [verbatim] grep — the self-heal cannot recover it, so
        // the run continues but warns.
        const lackingPrd = makeValidPrd("f", "feat/f");

        const agentManager = makeMockAgentManager({
          runWithFallbackFn: async (req: AgentRunRequest) => {
            const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
            return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
          },
          runAsSessionFn: async () => {
            await Bun.write(outputPath, JSON.stringify(lackingPrd));
            return {
              output: "written",
              estimatedCostUsd: 1,
              internalRoundTrips: 1,
              tokenUsage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        });

        const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
        createdRuntimes.push(runtime);

        const result = await callOp(
          {
            runtime,
            packageView: runtime.packages.repo(),
            packageDir: tempDir,
            agentName: runtime.agentManager.getDefault(),
            storyId: "f",
            featureName: "f",
          },
          planRefineOp,
          {
            specContent: '## ACs\n- [verbatim] `grep -rn "X" src/` returns zero matches',
            codebaseContext: "",
            featureName: "f",
            branchName: "feat/f",
            outputPath,
          },
        );

        expect(result.userStories.length).toBeGreaterThan(0); // plan continues
        const warn = verbatimWarn(warnSpy);
        expect(warn).toBeDefined();
        expect((warn?.[2] as Record<string, unknown>).missingCount).toBe(1);
      });
    });
  });
});

describe("planRefineOp.verify — [verbatim] residual-drift warning", () => {
  const SPEC_WITH_VERBATIM = '## Acceptance Criteria\n- [verbatim] `grep -rn "oldSym" src/` returns zero matches';

  function makeVerifyCtx(): VerifyContext<unknown> {
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    return {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => null,
      fileExists: async () => false,
    };
  }

  const input = {
    specContent: SPEC_WITH_VERBATIM,
    codebaseContext: "",
    featureName: "f",
    branchName: "feat/f",
    outputPath: "/tmp/x.json",
  };

  test("warns and still returns the PRD when a [verbatim] spec AC is dropped", async () => {
    await withWarnSpy(async (warnSpy) => {
      const prd = makeValidPrd("f", "feat/f"); // default AC does not contain the grep command
      const result = await planRefineOp.verify?.(prd as never, input as never, makeVerifyCtx());
      expect(result).toBeTruthy(); // continues
      const warn = verbatimWarn(warnSpy);
      expect(warn).toBeDefined();
      expect((warn?.[2] as Record<string, unknown>).missingCount).toBe(1);
    });
  });

  test("does not warn when the [verbatim] command survives in some PRD AC", async () => {
    await withWarnSpy(async (warnSpy) => {
      const base = makeValidPrd("f", "feat/f");
      const prd = {
        ...base,
        userStories: [
          {
            ...base.userStories[0],
            acceptanceCriteria: [
              'When cleanup completes, grep -rn "oldSym" src/ returns zero matches.',
              "handler rejects invalid input", // satisfies the negative-path structural check
            ],
          },
        ],
      };
      const result = await planRefineOp.verify?.(prd as never, input as never, makeVerifyCtx());
      expect(result).toBeTruthy();
      expect(verbatimWarn(warnSpy)).toBeUndefined();
    });
  });
});

describe("planRefineOp.hopBody — [verbatim] self-heal turn", () => {
  const SPEC = '## ACs\n- [verbatim] `grep -rn "X" src/` returns zero matches';

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
      input: { specContent: SPEC, codebaseContext: "", featureName: "f", branchName: "feat/f", outputPath: "/tmp/p.json" },
      send,
      sendWithParseRetry,
    } as unknown as Parameters<NonNullable<typeof planRefineOp.hopBody>>[1];
    return { ctx, send, sendWithParseRetry };
  }

  test("fires exactly one repair turn when the written PRD dropped a verbatim AC", async () => {
    _planRefineDeps.readFile = async () => JSON.stringify(makeValidPrd("f", "feat/f")); // AC lacks `grep ... "X"`
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildVerbatimRepair").mockReturnValue("REPAIR-PROMPT");
    const { ctx, send } = makeCtx();

    const result = await planRefineOp.hopBody!("init", ctx);

    expect(send).toHaveBeenCalledTimes(2); // refine + repair
    expect(repairSpy).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1][0]).toBe("REPAIR-PROMPT");
    expect(result.output).toBe("repaired");
    expect(result.estimatedCostUsd).toBe(5); // 1 (draft) + 2 (refine) + 2 (repair)
  });

  test("no repair turn when the written PRD preserved the verbatim AC", async () => {
    const base = makeValidPrd("f", "feat/f");
    const preserved = {
      ...base,
      userStories: [{ ...base.userStories[0], acceptanceCriteria: ['grep -rn "X" src/ returns zero matches'] }],
    };
    _planRefineDeps.readFile = async () => JSON.stringify(preserved);
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildVerbatimRepair");
    const { ctx, send } = makeCtx();

    const result = await planRefineOp.hopBody!("init", ctx);

    expect(send).toHaveBeenCalledTimes(1); // refine only
    expect(repairSpy).not.toHaveBeenCalled();
    expect(result.output).toBe("refined");
    expect(result.estimatedCostUsd).toBe(3); // 1 (draft) + 2 (refine)
  });

  test("no repair turn when the PRD file is absent or unparseable", async () => {
    _planRefineDeps.readFile = async () => null;
    const repairSpy = spyOn(PlanPromptBuilder.prototype, "buildVerbatimRepair");
    const { ctx, send } = makeCtx();

    await planRefineOp.hopBody!("init", ctx);

    expect(send).toHaveBeenCalledTimes(1);
    expect(repairSpy).not.toHaveBeenCalled();
  });
});

describe("planRefineOp.recover()", () => {
  test("returns null when the output file is missing", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: VerifyContext<unknown> = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await planRefineOp.recover?.(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/missing-prd.json",
      },
      ctx,
    );

    expect(result).toBeNull();
  });

  test("returns a parsed PRD when the output file contains valid JSON", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const validPrd = makeValidPrd("checkout-flow", "feat/checkout");
    const ctx: VerifyContext<unknown> = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => JSON.stringify(validPrd),
      fileExists: async () => true,
    };

    const result = await planRefineOp.recover?.(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/plan-refine-prd.json",
      },
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result?.feature).toBe("checkout-flow");
    expect(result?.branchName).toBe("feat/checkout");
    expect(result?.userStories).toHaveLength(1);
  });

  test("returns null when the output file contains invalid JSON", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: VerifyContext<unknown> = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => "not valid json {",
      fileExists: async () => true,
    };

    const result = await planRefineOp.recover?.(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/bad-prd.json",
      },
      ctx,
    );

    expect(result).toBeNull();
  });
});
