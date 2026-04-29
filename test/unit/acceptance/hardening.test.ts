import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type HardeningContext, _hardeningDeps, runHardeningPass } from "../../../src/acceptance/hardening";
import type { NaxConfig } from "../../../src/config";
import type { PRD } from "../../../src/prd/types";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makePRD(overrides: Partial<PRD> = {}): PRD {
  return {
    project: "test",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: [],
    ...overrides,
  };
}

const TEST_CONFIG = {
  autoMode: { defaultAgent: "claude" },
  models: {},
  acceptance: {
    model: "fast",
    hardening: { enabled: true },
  },
} as unknown as NaxConfig;

function makeCtx(overrides: Partial<HardeningContext> = {}): HardeningContext {
  return {
    prd: makePRD(),
    prdPath: "/tmp/prd.json",
    featureDir: "/tmp/features/test",
    workdir: "/tmp/workdir",
    config: TEST_CONFIG,
    agentManager: {
      getDefault: () => "claude",
      complete: mock(async () => ({ output: "", costUsd: 0, source: "fallback" })),
      run: mock(async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] })),
      completeAs: mock(async () => ({ output: "", costUsd: 0, source: "fallback" })),
      runAs: mock(async () => ({ success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] })),
      runWithFallback: mock(async () => ({ result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] })),
      completeWithFallback: mock(async () => ({ result: { output: "", costUsd: 0, source: "fallback" }, fallbacks: [] })),
      getAgent: mock(() => undefined),
      isUnavailable: mock(() => false),
      markUnavailable: mock(() => {}),
      reset: mock(() => {}),
      validateCredentials: mock(async () => {}),
      events: { on: mock(() => {}) } as any,
      resolveFallbackChain: mock(() => []),
      shouldSwap: mock(() => false),
      nextCandidate: mock(() => null),
      plan: mock(async () => ({ specContent: "" })),
      decompose: mock(async () => ({ stories: [] })),
    } as any,
    sessionManager: {
      openSession: mock(async () => ({ id: "test-session", role: "test" } as any)),
      closeSession: mock(async () => {}),
      getSession: mock(() => undefined),
      listSessions: mock(() => []),
      sendMessage: mock(async () => ({ success: true, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] })),
      on: mock(() => {}),
      off: mock(() => {}),
    } as any,
    runtime: {
      configLoader: { current: () => TEST_CONFIG },
      packages: {
        resolve: () => ({
          select: () => TEST_CONFIG,
        }),
        repo: () => ({ select: () => TEST_CONFIG }),
      },
      agentManager: {
        getDefault: () => "claude",
        completeAs: mock(async () => ({ output: "", costUsd: 0, source: "fallback" })),
        runWithFallback: mock(async () => ({ result: { success: true, exitCode: 0, output: "", rateLimited: false, durationMs: 0, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] })),
      },
      sessionManager: {
        openSession: mock(async () => ({ id: "test-session", role: "test" } as any)),
        closeSession: mock(async () => {}),
      },
      projectDir: "/tmp",
      signal: new AbortController().signal,
      onPidSpawned: undefined,
    } as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

// ─── Dep save/restore ───────────────────────────────────────────────────────

let origCallOp: typeof _hardeningDeps.callOp;
let origSavePRD: typeof _hardeningDeps.savePRD;
let origSpawn: typeof _hardeningDeps.spawn;
let origWriteFile: typeof _hardeningDeps.writeFile;

beforeEach(() => {
  origCallOp = _hardeningDeps.callOp;
  origSavePRD = _hardeningDeps.savePRD;
  origSpawn = _hardeningDeps.spawn;
  origWriteFile = _hardeningDeps.writeFile;
});

afterEach(() => {
  _hardeningDeps.callOp = origCallOp;
  _hardeningDeps.savePRD = origSavePRD;
  _hardeningDeps.spawn = origSpawn;
  _hardeningDeps.writeFile = origWriteFile;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runHardeningPass()", () => {
  test("returns empty result when no stories have suggestedCriteria", async () => {
    const ctx = makeCtx({
      prd: makePRD({
        userStories: [
          {
            id: "US-001",
            title: "Story",
            description: "Desc",
            acceptanceCriteria: ["AC-1"],
            tags: [],
            dependencies: [],
            status: "passed",
            passes: true,
            escalations: [],
            attempts: 1,
          },
        ],
      }),
    });

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual([]);
  });

  test("promotes passing suggested criteria to acceptanceCriteria", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["suggested edge case"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [{ original: "suggested edge case", refined: "suggested edge case", testable: true, storyId: "US-001" }];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => {
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode("(pass) AC-1: suggested edge case\n"));
            ctrl.close();
          },
        }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      } as ReturnType<typeof Bun.spawn>;
    });

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual(["suggested edge case"]);
    expect(result.discarded).toEqual([]);
    expect(story.acceptanceCriteria).toContain("suggested edge case");
    expect(story.suggestedCriteria).toBeUndefined();
    expect(_hardeningDeps.savePRD).toHaveBeenCalledTimes(1);
  });

  test("discards failing suggested criteria", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["failing edge case"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [{ original: "failing edge case", refined: "failing edge case", testable: true, storyId: "US-001" }];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => {
      return {
        exited: Promise.resolve(1),
        stdout: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode("(fail) AC-1: failing edge case\n"));
            ctrl.close();
          },
        }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      } as ReturnType<typeof Bun.spawn>;
    });

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual(["failing edge case"]);
    expect(story.acceptanceCriteria).toEqual(["spec AC"]);
    expect(story.suggestedCriteria).toEqual(["failing edge case"]);
    expect(_hardeningDeps.savePRD).not.toHaveBeenCalled();
  });

  test("discards testable:false criteria even when the stub test passes", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["cli.ts contains an import of writeFileSync"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [{ original: "cli.ts contains an import of writeFileSync", refined: "cli.ts contains an import of writeFileSync", testable: false, storyId: "US-001" }];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => { expect(true).toBe(true); })' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => {
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      } as ReturnType<typeof Bun.spawn>;
    });

    const result = await runHardeningPass(ctx);

    // Despite passing tests, testable:false must be discarded — not promoted
    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual(["cli.ts contains an import of writeFileSync"]);
    expect(story.acceptanceCriteria).toEqual(["spec AC"]);
    expect(_hardeningDeps.savePRD).not.toHaveBeenCalled();
  });

  test("promotes testable:true criterion while discarding testable:false in same story", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["behavioral edge case", "cli.ts contains an import"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [
          { original: "behavioral edge case", refined: "behavioral edge case", testable: true, storyId: "US-001" },
          { original: "cli.ts contains an import", refined: "cli.ts contains an import", testable: false, storyId: "US-001" },
        ];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})\ntest("AC-2", () => { expect(true).toBe(true); })' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => {
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
        stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      } as ReturnType<typeof Bun.spawn>;
    });

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual(["behavioral edge case"]);
    expect(result.discarded).toEqual(["cli.ts contains an import"]);
    expect(story.acceptanceCriteria).toContain("behavioral edge case");
    expect(story.acceptanceCriteria).not.toContain("cli.ts contains an import");
    expect(_hardeningDeps.savePRD).toHaveBeenCalledTimes(1);
  });

  test("does not throw on error — returns partial result", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mock(async () => {
      throw new Error("callOp failed");
    });

    const result = await runHardeningPass(ctx);

    // Should not throw, returns empty result
    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual([]);
  });

  test("mapping loop driven from allRefined prevents AC index drift when refine count changes (#336 gap 4)", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      // 3 suggested criteria, but refine deduplicates to 2
      suggestedCriteria: ["dup criterion A", "dup criterion A", "passing criterion"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [
          { original: "dup criterion A", refined: "dup criterion A", testable: true, storyId: "US-001" },
          { original: "passing criterion", refined: "passing criterion", testable: true, storyId: "US-001" },
        ];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})\ntest("AC-2", () => {})' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
    } as ReturnType<typeof Bun.spawn>));

    const result = await runHardeningPass(ctx);

    // Both refined criteria pass — only the 2 returned by refine are promoted
    expect(result.promoted).toEqual(["dup criterion A", "passing criterion"]);
    expect(result.discarded).toEqual([]);
  });

  test("deduplicates against existing acceptanceCriteria when promoting (#336 gap 5)", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC", "already promoted criterion"],
      suggestedCriteria: ["already promoted criterion", "new criterion"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [
          { original: "already promoted criterion", refined: "already promoted criterion", testable: true, storyId: "US-001" },
          { original: "new criterion", refined: "new criterion", testable: true, storyId: "US-001" },
        ];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})\ntest("AC-2", () => {})' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
    } as ReturnType<typeof Bun.spawn>));

    await runHardeningPass(ctx);

    // "already promoted criterion" must not appear twice
    const count = story.acceptanceCriteria.filter((ac) => ac === "already promoted criterion").length;
    expect(count).toBe(1);
    expect(story.acceptanceCriteria).toContain("new criterion");
  });

  test("falls back to skeleton tests when acceptanceGenerateOp returns null testCode", async () => {
    const story = {
      id: "US-001",
      title: "Story",
      description: "Desc",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    _hardeningDeps.callOp = mock(async (_ctx, op, _input) => {
      if (op.name === "acceptance-refine") {
        return [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: null };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
    } as ReturnType<typeof Bun.spawn>));

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual(["edge case"]);
    expect(_hardeningDeps.writeFile).toHaveBeenCalled();
    const writeCall = (_hardeningDeps.writeFile as ReturnType<typeof mock>).mock.calls[0];
    expect(typeof writeCall[1]).toBe("string");
    expect((writeCall[1] as string).length).toBeGreaterThan(0);
  });

  test("calls acceptanceRefineOp with story context fields", async () => {
    const story = {
      id: "US-001",
      title: "Story Title",
      description: "Story Description",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      tags: [],
      dependencies: [],
      status: "passed" as const,
      passes: true,
      escalations: [],
      attempts: 1,
    };
    const prd = makePRD({ userStories: [story] });
    const ctx = makeCtx({ prd });

    let capturedRefineInput: unknown;
    _hardeningDeps.callOp = mock(async (_ctx, op, input) => {
      if (op.name === "acceptance-refine") {
        capturedRefineInput = input;
        return [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    });
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
    } as ReturnType<typeof Bun.spawn>));

    await runHardeningPass(ctx);

    expect(capturedRefineInput).toBeDefined();
    const refineInput = capturedRefineInput as Record<string, unknown>;
    expect(refineInput.storyId).toBe("US-001");
    expect(refineInput.storyTitle).toBe("Story Title");
    expect(refineInput.storyDescription).toBe("Story Description");
  });
});
