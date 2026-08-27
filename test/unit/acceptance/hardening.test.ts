import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSessionManager,
  makeStory,
} from "@test/helpers";
import { _hardeningDeps, type HardeningContext, runHardeningPass } from "@/acceptance/hardening";
import type { NaxConfig } from "@/config";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TEST_CONFIG: NaxConfig = makeNaxConfig({
  agent: { default: "claude" },
  acceptance: {
    model: "fast",
    hardening: { enabled: true },
  },
});

function makeCtx(overrides: Partial<HardeningContext> = {}): HardeningContext {
  const agentManager = makeMockAgentManager();
  const runtimeAgentManager = makeMockAgentManager();
  return {
    prd: makePRD(),
    prdPath: "/tmp/prd.json",
    featureDir: "/tmp/features/test",
    workdir: "/tmp/workdir",
    config: TEST_CONFIG,
    agentManager,
    sessionManager: makeSessionManager(),
    runtime: makeMockRuntime({ agentManager: runtimeAgentManager, config: TEST_CONFIG }),
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

// ─── Dep save/restore ───────────────────────────────────────────────────────

let origCallOp: typeof _hardeningDeps.callOp;
let origSavePRD: typeof _hardeningDeps.savePRD;
let origSpawn: typeof _hardeningDeps.spawn;
let origWriteFile: typeof _hardeningDeps.writeFile;
let origDetectLanguage: typeof _hardeningDeps.detectLanguage;

beforeEach(() => {
  origCallOp = _hardeningDeps.callOp;
  origSavePRD = _hardeningDeps.savePRD;
  origSpawn = _hardeningDeps.spawn;
  origWriteFile = _hardeningDeps.writeFile;
  origDetectLanguage = _hardeningDeps.detectLanguage;
  // Stub out language detection so tests don't hit the filesystem
  _hardeningDeps.detectLanguage = mock(async () => undefined);
});

afterEach(() => {
  _hardeningDeps.callOp = origCallOp;
  _hardeningDeps.savePRD = origSavePRD;
  _hardeningDeps.spawn = origSpawn;
  _hardeningDeps.writeFile = origWriteFile;
  _hardeningDeps.detectLanguage = origDetectLanguage;
});

// ─── Spawn helpers ───────────────────────────────────────────────────────────

function passingSpawn() {
  return mock(
    () =>
      ({
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(ctrl) {
            ctrl.close();
          },
        }),
        stderr: new ReadableStream({
          start(ctrl) {
            ctrl.close();
          },
        }),
      }) as ReturnType<typeof Bun.spawn>,
  );
}

function failingSpawn(output: string) {
  return mock(
    () =>
      ({
        exited: Promise.resolve(1),
        stdout: new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode(output));
            ctrl.close();
          },
        }),
        stderr: new ReadableStream({
          start(ctrl) {
            ctrl.close();
          },
        }),
      }) as ReturnType<typeof Bun.spawn>,
  );
}

function mockCallOp(refineReturn: object[], generateReturn: object): typeof _hardeningDeps.callOp {
  return mock(async (_ctx: unknown, op: { name: string }, _input: unknown) => {
    if (op.name === "acceptance-refine") return refineReturn;
    if (op.name === "acceptance-generate") return generateReturn;
    throw new Error(`Unexpected op: ${op.name}`);
  }) as typeof _hardeningDeps.callOp;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("runHardeningPass()", () => {
  test("returns empty result when no stories have suggestedCriteria", async () => {
    const ctx = makeCtx({
      prd: makePRD({ userStories: [makeStory({ status: "passed", passes: true, attempts: 1 })] }),
    });

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual([]);
  });

  test("promotes passing suggested criteria to acceptanceCriteria", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["suggested edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [{ original: "suggested edge case", refined: "suggested edge case", testable: true, storyId: "US-001" }],
      { testCode: 'test("AC-1", () => {})' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(
      () =>
        ({
          exited: Promise.resolve(0),
          stdout: new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(new TextEncoder().encode("(pass) AC-1: suggested edge case\n"));
              ctrl.close();
            },
          }),
          stderr: new ReadableStream({
            start(ctrl) {
              ctrl.close();
            },
          }),
        }) as ReturnType<typeof Bun.spawn>,
    );

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual(["suggested edge case"]);
    expect(result.discarded).toEqual([]);
    expect(story.acceptanceCriteria).toContain("suggested edge case");
    expect(story.suggestedCriteria).toBeUndefined();
    expect(_hardeningDeps.savePRD).toHaveBeenCalledTimes(1);
  });

  test("discards failing suggested criteria", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["failing edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [{ original: "failing edge case", refined: "failing edge case", testable: true, storyId: "US-001" }],
      { testCode: 'test("AC-1", () => {})' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = failingSpawn("(fail) AC-1: failing edge case\n");

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual(["failing edge case"]);
    expect(story.acceptanceCriteria).toEqual(["spec AC"]);
    expect(story.suggestedCriteria).toEqual(["failing edge case"]);
    expect(_hardeningDeps.savePRD).not.toHaveBeenCalled();
  });

  // BUG-14: an acceptance-test command that fails opaquely (timeout kill, missing
  // venv, syntax error) previously discarded EVERY suggested criterion — the
  // `(exitCode !== 0 && failedACs.length === 0)` disjunct treated an inconclusive
  // run as a verdict. Inconclusive must keep the criteria, not delete them.
  test("keeps suggested criteria when the test command fails without parseable AC ids (inconclusive run) — BUG-14", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }],
      { testCode: 'test("AC-1", () => {})' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = failingSpawn("ModuleNotFoundError: cannot load test file\n");

    const result = await runHardeningPass(ctx);

    // The opaque failure is inconclusive, not a per-AC verdict — nothing is discarded.
    expect(result.promoted).toEqual(["edge case"]);
    expect(result.discarded).toEqual([]);
    expect(story.acceptanceCriteria).toContain("edge case");
    expect(story.suggestedCriteria).toBeUndefined();
    expect(_hardeningDeps.savePRD).toHaveBeenCalledTimes(1);
  });

  test("discards testable:false criteria even when the stub test passes", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["cli.ts contains an import of writeFileSync"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [
        {
          original: "cli.ts contains an import of writeFileSync",
          refined: "cli.ts contains an import of writeFileSync",
          testable: false,
          storyId: "US-001",
        },
      ],
      { testCode: 'test("AC-1", () => { expect(true).toBe(true); })' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    const result = await runHardeningPass(ctx);

    // Despite passing tests, testable:false must be discarded — not promoted
    expect(result.promoted).toEqual([]);
    expect(result.discarded).toEqual(["cli.ts contains an import of writeFileSync"]);
    expect(story.acceptanceCriteria).toEqual(["spec AC"]);
    expect(_hardeningDeps.savePRD).not.toHaveBeenCalled();
  });

  test("promotes testable:true criterion while discarding testable:false in same story", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["behavioral edge case", "cli.ts contains an import"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [
        { original: "behavioral edge case", refined: "behavioral edge case", testable: true, storyId: "US-001" },
        {
          original: "cli.ts contains an import",
          refined: "cli.ts contains an import",
          testable: false,
          storyId: "US-001",
        },
      ],
      { testCode: 'test("AC-1", () => {})\ntest("AC-2", () => { expect(true).toBe(true); })' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual(["behavioral edge case"]);
    expect(result.discarded).toEqual(["cli.ts contains an import"]);
    expect(story.acceptanceCriteria).toContain("behavioral edge case");
    expect(story.acceptanceCriteria).not.toContain("cli.ts contains an import");
    expect(_hardeningDeps.savePRD).toHaveBeenCalledTimes(1);
  });

  test("does not throw on error — returns partial result", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
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
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      // 3 suggested criteria, but refine deduplicates to 2
      suggestedCriteria: ["dup criterion A", "dup criterion A", "passing criterion"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [
        { original: "dup criterion A", refined: "dup criterion A", testable: true, storyId: "US-001" },
        { original: "passing criterion", refined: "passing criterion", testable: true, storyId: "US-001" },
      ],
      { testCode: 'test("AC-1", () => {})\ntest("AC-2", () => {})' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    const result = await runHardeningPass(ctx);

    // Both refined criteria pass — only the 2 returned by refine are promoted
    expect(result.promoted).toEqual(["dup criterion A", "passing criterion"]);
    expect(result.discarded).toEqual([]);
  });

  test("deduplicates against existing acceptanceCriteria when promoting (#336 gap 5)", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC", "already promoted criterion"],
      suggestedCriteria: ["already promoted criterion", "new criterion"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [
        {
          original: "already promoted criterion",
          refined: "already promoted criterion",
          testable: true,
          storyId: "US-001",
        },
        { original: "new criterion", refined: "new criterion", testable: true, storyId: "US-001" },
      ],
      { testCode: 'test("AC-1", () => {})\ntest("AC-2", () => {})' },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    await runHardeningPass(ctx);

    // "already promoted criterion" must not appear twice
    const count = story.acceptanceCriteria.filter((ac) => ac === "already promoted criterion").length;
    expect(count).toBe(1);
    expect(story.acceptanceCriteria).toContain("new criterion");
  });

  test("falls back to skeleton tests when acceptanceGenerateOp returns null testCode", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    _hardeningDeps.callOp = mockCallOp(
      [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }],
      { testCode: null },
    );
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    const result = await runHardeningPass(ctx);

    expect(result.promoted).toEqual(["edge case"]);
    expect(_hardeningDeps.writeFile).toHaveBeenCalled();
    const writeCall = (_hardeningDeps.writeFile as ReturnType<typeof mock>).mock.calls[0];
    expect(typeof writeCall[1]).toBe("string");
    expect((writeCall[1] as string).length).toBeGreaterThan(0);
  });

  test("calls acceptanceRefineOp with story context fields", async () => {
    const story = makeStory({
      title: "Story Title",
      description: "Story Description",
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    let capturedRefineInput: unknown;
    _hardeningDeps.callOp = mock(async (_ctx: unknown, op: { name: string }, input: unknown) => {
      if (op.name === "acceptance-refine") {
        capturedRefineInput = input;
        return [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }];
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => {})' };
      }
      throw new Error(`Unexpected op: ${op.name}`);
    }) as typeof _hardeningDeps.callOp;
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    await runHardeningPass(ctx);

    expect(capturedRefineInput).toBeDefined();
    const refineInput = capturedRefineInput as Record<string, unknown>;
    expect(refineInput.storyId).toBe("US-001");
    expect(refineInput.storyTitle).toBe("Story Title");
    expect(refineInput.storyDescription).toBe("Story Description");
  });

  test("uses packageDir (not workdir) for suggested test path in monorepo", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      workdir: "packages/api",
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({ prd: makePRD({ userStories: [story] }) });

    const writtenPaths: string[] = [];
    _hardeningDeps.callOp = mockCallOp(
      [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }],
      { testCode: 'test("AC-1", () => {})' },
    );
    _hardeningDeps.writeFile = mock(async (p: string) => {
      writtenPaths.push(p);
    });
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = passingSpawn();

    await runHardeningPass(ctx);

    expect(writtenPaths).toHaveLength(1);
    // Must be under <packageDir>/.nax, not <workdir>/.nax
    expect(writtenPaths[0]).toContain("/tmp/workdir/packages/api/.nax/");
    expect(writtenPaths[0]).not.toMatch(/^\/tmp\/workdir\/\.nax\//);
  });

  // BUG-04: hardening's acceptance-test spawn previously had no wall-clock
  // deadline — a hanging LLM-generated test (open server, watch mode) wedged
  // the run's completion phase forever. Verify SIGTERM->SIGKILL escalation
  // fires and the pass terminates instead of hanging.
  test("terminates via SIGTERM when the test command hangs past config.acceptance.timeoutMs", async () => {
    const story = makeStory({
      acceptanceCriteria: ["spec AC"],
      suggestedCriteria: ["edge case"],
      status: "passed",
      passes: true,
      attempts: 1,
    });
    const ctx = makeCtx({
      prd: makePRD({ userStories: [story] }),
      config: {
        ...TEST_CONFIG,
        acceptance: { ...TEST_CONFIG.acceptance, timeoutMs: 50 },
      },
    });

    const originalKill = process.kill;
    const killCalls: Array<[number, string]> = [];
    let resolveExited!: (code: number) => void;
    const exitedPromise = new Promise<number>((res) => {
      resolveExited = res;
    });
    process.kill = ((pid: number, signal?: string) => {
      killCalls.push([pid, signal as string]);
      if (signal === "SIGTERM") resolveExited(143);
      return true;
    }) as typeof process.kill;

    try {
      _hardeningDeps.callOp = mockCallOp(
        [{ original: "edge case", refined: "edge case", testable: true, storyId: "US-001" }],
        { testCode: 'test("AC-1", () => {})' },
      );
      _hardeningDeps.writeFile = mock(async () => {});
      _hardeningDeps.savePRD = mock(async () => {});
      _hardeningDeps.spawn = mock(
        () =>
          ({
            pid: 4242,
            exited: exitedPromise,
            stdout: new ReadableStream({
              start(ctrl) {
                ctrl.close();
              },
            }),
            stderr: new ReadableStream({
              start(ctrl) {
                ctrl.close();
              },
            }),
          }) as ReturnType<typeof Bun.spawn>,
      );

      await runHardeningPass(ctx);

      expect(killCalls.some(([pid, signal]) => pid === -4242 && signal === "SIGTERM")).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });
});
