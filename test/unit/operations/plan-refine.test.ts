import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  makeMockAgentManager,
  makeSessionManager,
  makeTestRuntime,
  opSelector,
  withTempDir,
  withWarnSpy,
} from "@test/helpers";
import type { AgentRunRequest } from "@/agents/manager-types";
import type { PlanConfig } from "@/config/selectors";
import type { PlanRefineInput, VerifyContext } from "@/operations";
import { _planRefineDeps, callOp, normalizeCreatedContextFiles, planInteractiveOp, planRefineOp } from "@/operations";
import type { HopBodyContext } from "@/operations/types";
import { PlanPromptBuilder } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

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
    const ctx = { packageView: view, config: view.select(opSelector(planInteractiveOp.config)) };

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

    assertDefined(planRefineOp.hopBody, "planRefineOp.hopBody");
    const result = await planRefineOp.hopBody(initialPrompt, ctx);

    expect(sendWithParseRetry).toHaveBeenCalledTimes(1);
    expect(sendWithParseRetry).toHaveBeenCalledWith(initialPrompt);
    expect(send).toHaveBeenCalledTimes(1);
    expect(buildRefineContinuationSpy).toHaveBeenCalledTimes(1);
    expect(buildRefineContinuationSpy).toHaveBeenCalledWith("/tmp/plan-refine-prd.json", false);
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

describe("planRefineOp.hopBody — specGuard spec-drift repair turn", () => {
  const SPEC = "# Spec\n- [unit] does a thing";

  function turn(output: string, cost: number) {
    return { output, estimatedCostUsd: cost, internalRoundTrips: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 } };
  }

  function makeCtx(specGuard: boolean) {
    const sendWithParseRetry = mock(async () => turn("draft", 1));
    let sendCount = 0;
    const send = mock(async (_p: string) => {
      sendCount += 1;
      return turn(sendCount === 1 ? "refined" : "drift-repaired", 2);
    });
    const ctx: HopBodyContext<PlanRefineInput> = {
      input: {
        specContent: SPEC,
        codebaseContext: "",
        featureName: "f",
        branchName: "feat/f",
        outputPath: "/tmp/p.json",
        specGuard,
      },
      send,
      sendWithParseRetry,
    };
    return { ctx, send };
  }

  function makeDriftPrd() {
    const base = makeValidPrd("f", "feat/f");
    return {
      ...base,
      userStories: [
        {
          ...base.userStories[0],
          acceptanceCriteria: ["- [grep] `grep -rn foo src/` returns 0", "handler rejects invalid input"],
        },
      ],
    };
  }

  test("fires exactly one repair turn when specGuard=true and PRD has a deprecated-tag AC", async () => {
    _planRefineDeps.readFile = async () => JSON.stringify(makeDriftPrd());
    const driftSpy = spyOn(PlanPromptBuilder.prototype, "buildSpecDriftRepair").mockReturnValue("DRIFT-REPAIR");
    const { ctx, send } = makeCtx(true);

    const result = await planRefineOp.hopBody!("init", ctx);

    expect(send).toHaveBeenCalledTimes(2); // refine + drift repair
    expect(driftSpy).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1]?.[0]).toBe("DRIFT-REPAIR");
    expect(result.output).toBe("drift-repaired");
    expect(result.estimatedCostUsd).toBe(5); // 1 (draft) + 2 (refine) + 2 (drift repair)
  });

  test("no repair turn when specGuard=true but PRD is clean", async () => {
    _planRefineDeps.readFile = async () => JSON.stringify(makeValidPrd("f", "feat/f"));
    const driftSpy = spyOn(PlanPromptBuilder.prototype, "buildSpecDriftRepair");
    const { ctx, send } = makeCtx(true);

    const result = await planRefineOp.hopBody!("init", ctx);

    expect(send).toHaveBeenCalledTimes(1); // refine only
    expect(driftSpy).not.toHaveBeenCalled();
    expect(result.output).toBe("refined");
    expect(result.estimatedCostUsd).toBe(3); // 1 (draft) + 2 (refine)
  });

  test("no repair turn when specGuard=false even if PRD has drift violations", async () => {
    _planRefineDeps.readFile = async () => JSON.stringify(makeDriftPrd());
    const driftSpy = spyOn(PlanPromptBuilder.prototype, "buildSpecDriftRepair");
    const { ctx, send } = makeCtx(false);

    await planRefineOp.hopBody!("init", ctx);

    expect(send).toHaveBeenCalledTimes(1); // refine only
    expect(driftSpy).not.toHaveBeenCalled();
  });
});

describe("planRefineOp.verify — specGuard warnOnSpecDrift", () => {
  function makeVerifyCtx(specGuard: boolean): VerifyContext<PlanConfig> {
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const base = view.select(opSelector(planRefineOp.config));
    return {
      packageView: view,
      config: { ...base, plan: { ...base.plan, specGuard } },
      readFile: async () => null,
      fileExists: async () => false,
    };
  }

  const input = {
    specContent: "# Spec",
    codebaseContext: "",
    featureName: "f",
    branchName: "feat/f",
    outputPath: "/tmp/x.json",
  };

  function makeDriftPrd() {
    const base = makeValidPrd("f", "feat/f");
    return {
      ...base,
      userStories: [
        {
          ...base.userStories[0],
          acceptanceCriteria: ["- [grep] `grep foo` returns 0", "handler rejects invalid input"],
        },
      ],
    };
  }

  test("emits spec-drift warning when specGuard=true and violations remain", async () => {
    await withWarnSpy(async (warnSpy) => {
      const result = await planRefineOp.verify?.(makeDriftPrd() as never, input as never, makeVerifyCtx(true));
      expect(result).toBeTruthy();
      const call = warnSpy.mock.calls.find((c) => typeof c[1] === "string" && c[1].includes("spec-drift"));
      expect(call).toBeDefined();
      expect((call?.[2] as Record<string, unknown> | undefined)?.violationCount).toBe(1);
    });
  });

  test("does not emit spec-drift warning when specGuard=false even with violations", async () => {
    await withWarnSpy(async (warnSpy) => {
      await planRefineOp.verify?.(makeDriftPrd() as never, input as never, makeVerifyCtx(false));
      const driftWarn = warnSpy.mock.calls.find((c) => typeof c[1] === "string" && c[1].includes("spec-drift"));
      expect(driftWarn).toBeUndefined();
    });
  });
});

describe("planRefineOp.recover()", () => {
  test("returns null when the output file is missing", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: VerifyContext<PlanConfig> = {
      packageView: view,
      config: view.select(opSelector(planInteractiveOp.config)),
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
    const ctx: VerifyContext<PlanConfig> = {
      packageView: view,
      config: view.select(opSelector(planInteractiveOp.config)),
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
    const ctx: VerifyContext<PlanConfig> = {
      packageView: view,
      config: view.select(opSelector(planInteractiveOp.config)),
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

describe("normalizeCreatedContextFiles — move absent reads to expectedFiles", () => {
  const WORKDIR = "/repo";

  function prdWith(contextFiles: Array<string | { path: string; factId?: string }>, expectedFiles?: string[]) {
    const base = makeValidPrd("f", "feat/f");
    return {
      ...base,
      userStories: [{ ...base.userStories[0], contextFiles, expectedFiles }],
    };
  }

  function story0(prd: { userStories: Array<Record<string, unknown>> }) {
    return prd.userStories[0] as { contextFiles?: unknown[]; expectedFiles?: string[] };
  }

  test("moves an uncited contextFile absent on disk into expectedFiles", async () => {
    await withWarnSpy(async () => {
      const fileExists = mock(async () => false);
      const out = await normalizeCreatedContextFiles(prdWith(["src/_chat.ts"]) as never, WORKDIR, fileExists);
      const s = story0(out as never);
      expect(s.expectedFiles).toEqual(["src/_chat.ts"]);
      expect(s.contextFiles ?? []).toEqual([]); // removed from the read list
      expect(fileExists).toHaveBeenCalledWith(join(WORKDIR, "src/_chat.ts"));
    });
  });

  test("keeps a contextFile that exists on disk as a read (no move)", async () => {
    await withWarnSpy(async () => {
      const fileExists = mock(async () => true);
      const prd = prdWith(["src/real.ts"]);
      const out = await normalizeCreatedContextFiles(prd as never, WORKDIR, fileExists);
      expect(out).toBe(prd as never); // unchanged → same reference
    });
  });

  test("does not duplicate a path already declared in expectedFiles", async () => {
    await withWarnSpy(async () => {
      const fileExists = mock(async () => false);
      const out = await normalizeCreatedContextFiles(
        prdWith(["src/_chat.ts"], ["src/_chat.ts"]) as never,
        WORKDIR,
        fileExists,
      );
      const s = story0(out as never);
      // already an output — absence is expected, no move, no duplicate
      expect(s.expectedFiles).toEqual(["src/_chat.ts"]);
    });
  });

  test("keeps and warns for a CITED contextFile absent on disk (broken grounding, not a create)", async () => {
    await withWarnSpy(async (warnSpy) => {
      const fileExists = mock(async () => false);
      const out = await normalizeCreatedContextFiles(
        prdWith([{ path: "src/cited.ts", factId: "F-001" }]) as never,
        WORKDIR,
        fileExists,
      );
      const s = story0(out as never);
      expect(s.contextFiles).toEqual([{ path: "src/cited.ts", factId: "F-001" }]); // kept
      expect(s.expectedFiles ?? []).toEqual([]); // NOT moved
      const warns = warnSpy.mock.calls.filter((c) => c[0] === "plan" && String(c[1]).includes("cites a manifest fact"));
      expect(warns.length).toBe(1);
    });
  });

  test("keeps an absent contextFile produced by an upstream dependency (cross-story read, not a create)", async () => {
    await withWarnSpy(async () => {
      const base = makeValidPrd("f", "feat/f");
      const producer = { ...base.userStories[0], id: "US-001", contextFiles: [], expectedFiles: ["src/Card.tsx"] };
      const consumer = {
        ...base.userStories[0],
        id: "US-002",
        dependencies: ["US-001"],
        contextFiles: ["src/Card.tsx"], // created by US-001 — absent on disk at plan time
        expectedFiles: ["src/Badge.tsx"],
      };
      const prd = { ...base, userStories: [producer, consumer] };
      const fileExists = mock(async () => false); // nothing on disk yet

      const out = (await normalizeCreatedContextFiles(prd as never, WORKDIR, fileExists)) as never as {
        userStories: Array<{ id: string; contextFiles?: unknown[]; expectedFiles?: string[] }>;
      };

      const b = out.userStories.find((s) => s.id === "US-002")!;
      // Kept as a read hint — NOT moved to expectedFiles (US-002 reads it but does not author it).
      expect(b.contextFiles).toEqual(["src/Card.tsx"]);
      expect(b.expectedFiles).toEqual(["src/Badge.tsx"]);
    });
  });

  test("moves an absent contextFile to expectedFiles when NO upstream dependency produces it", async () => {
    await withWarnSpy(async () => {
      const base = makeValidPrd("f", "feat/f");
      // US-002 depends on US-001, but US-001 does not create src/own.tsx → US-002 creates it.
      const producer = { ...base.userStories[0], id: "US-001", contextFiles: [], expectedFiles: ["src/Card.tsx"] };
      const consumer = {
        ...base.userStories[0],
        id: "US-002",
        dependencies: ["US-001"],
        contextFiles: ["src/own.tsx"],
      };
      const prd = { ...base, userStories: [producer, consumer] };
      const fileExists = mock(async () => false);

      const out = (await normalizeCreatedContextFiles(prd as never, WORKDIR, fileExists)) as never as {
        userStories: Array<{ id: string; contextFiles?: unknown[]; expectedFiles?: string[] }>;
      };

      const b = out.userStories.find((s) => s.id === "US-002")!;
      expect(b.contextFiles ?? []).toEqual([]);
      expect(b.expectedFiles).toEqual(["src/own.tsx"]);
    });
  });

  test("is a no-op (returns input) when workdir is undefined", async () => {
    const fileExists = mock(async () => false);
    const prd = prdWith(["src/ghost.ts"]);
    const out = await normalizeCreatedContextFiles(prd as never, undefined, fileExists);
    expect(out).toBe(prd as never);
    expect(fileExists).not.toHaveBeenCalled();
  });

  test("across multiple stories: moves in the changed story, preserves the unchanged story's reference", async () => {
    await withWarnSpy(async () => {
      const base = makeValidPrd("f", "feat/f");
      const s0 = { ...base.userStories[0], id: "US-001", contextFiles: ["src/real.ts"] }; // exists → unchanged
      const s1 = { ...base.userStories[0], id: "US-002", contextFiles: ["src/_new.ts"] }; // absent → moved
      const prd = { ...base, userStories: [s0, s1] };
      // Only src/real.ts exists on disk.
      const fileExists = mock(async (p: string) => p.endsWith("src/real.ts"));

      const out = (await normalizeCreatedContextFiles(prd as never, WORKDIR, fileExists)) as never as {
        userStories: Array<{ id: string; contextFiles?: unknown[]; expectedFiles?: string[] }>;
      };

      expect(out).not.toBe(prd as never); // a story changed → new PRD object
      const a = out.userStories.find((s) => s.id === "US-001")!;
      const b = out.userStories.find((s) => s.id === "US-002")!;
      // Unchanged story keeps its original object reference (no needless copy).
      expect(a).toBe(s0 as never);
      expect(a.contextFiles).toEqual(["src/real.ts"]);
      // Changed story moved its absent read to expectedFiles.
      expect(b.contextFiles ?? []).toEqual([]);
      expect(b.expectedFiles).toEqual(["src/_new.ts"]);
    });
  });
});
