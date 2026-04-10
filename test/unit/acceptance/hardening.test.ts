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
    ...overrides,
  };
}

// ─── Dep save/restore ───────────────────────────────────────────────────────

let origRefine: typeof _hardeningDeps.refine;
let origGenerate: typeof _hardeningDeps.generate;
let origSavePRD: typeof _hardeningDeps.savePRD;
let origSpawn: typeof _hardeningDeps.spawn;
let origWriteFile: typeof _hardeningDeps.writeFile;

beforeEach(() => {
  origRefine = _hardeningDeps.refine;
  origGenerate = _hardeningDeps.generate;
  origSavePRD = _hardeningDeps.savePRD;
  origSpawn = _hardeningDeps.spawn;
  origWriteFile = _hardeningDeps.writeFile;
});

afterEach(() => {
  _hardeningDeps.refine = origRefine;
  _hardeningDeps.generate = origGenerate;
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
    expect(result.costUsd).toBe(0);
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

    _hardeningDeps.refine = mock(async (criteria: string[]) => ({
      criteria: criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" })),
      costUsd: 0.001,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [{ id: "AC-1", text: "suggested edge case", lineNumber: 1 }],
      costUsd: 0.002,
    }));
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

    _hardeningDeps.refine = mock(async (criteria: string[]) => ({
      criteria: criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" })),
      costUsd: 0,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [{ id: "AC-1", text: "failing edge case", lineNumber: 1 }],
      costUsd: 0,
    }));
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

    // Refiner marks it non-testable (implementation detail)
    _hardeningDeps.refine = mock(async (criteria: string[]) => ({
      criteria: criteria.map((c) => ({ original: c, refined: c, testable: false, storyId: "US-001" })),
      costUsd: 0,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => { expect(true).toBe(true); })',
      criteria: [{ id: "AC-1", text: "cli.ts contains an import of writeFileSync", lineNumber: 1 }],
      costUsd: 0,
    }));
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    // Test "passes" (exit 0, no failures) — stub always passes
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

    _hardeningDeps.refine = mock(async (criteria: string[]) => ({
      criteria: criteria.map((c, i) => ({
        original: c,
        refined: c,
        testable: i === 0, // first testable, second not
        storyId: "US-001",
      })),
      costUsd: 0,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})\ntest("AC-2", () => { expect(true).toBe(true); })',
      criteria: [
        { id: "AC-1", text: "behavioral edge case", lineNumber: 1 },
        { id: "AC-2", text: "cli.ts contains an import", lineNumber: 2 },
      ],
      costUsd: 0,
    }));
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

    _hardeningDeps.refine = mock(async () => {
      throw new Error("refine failed");
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

    // Refiner deduplicates: returns only 2 criteria instead of 3
    _hardeningDeps.refine = mock(async () => ({
      criteria: [
        { original: "dup criterion A", refined: "dup criterion A", testable: true, storyId: "US-001" },
        { original: "passing criterion", refined: "passing criterion", testable: true, storyId: "US-001" },
      ],
      costUsd: 0,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})\ntest("AC-2", () => {})',
      criteria: [
        { id: "AC-1", text: "dup criterion A", lineNumber: 1 },
        { id: "AC-2", text: "passing criterion", lineNumber: 2 },
      ],
      costUsd: 0,
    }));
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    // Both tests pass
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

    _hardeningDeps.refine = mock(async (criteria: string[]) => ({
      criteria: criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" })),
      costUsd: 0,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})\ntest("AC-2", () => {})',
      criteria: [
        { id: "AC-1", text: "already promoted criterion", lineNumber: 1 },
        { id: "AC-2", text: "new criterion", lineNumber: 2 },
      ],
      costUsd: 0,
    }));
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    // Both tests pass
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

  test("accumulates costUsd from refine and generate sub-calls (#336 gap 3)", async () => {
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

    _hardeningDeps.refine = mock(async (criteria: string[]) => ({
      criteria: criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" })),
      costUsd: 0.005,
    }));
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [{ id: "AC-1", text: "edge case", lineNumber: 1 }],
      costUsd: 0.010,
    }));
    _hardeningDeps.writeFile = mock(async () => {});
    _hardeningDeps.savePRD = mock(async () => {});
    _hardeningDeps.spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
      stderr: new ReadableStream({ start(ctrl) { ctrl.close(); } }),
    } as ReturnType<typeof Bun.spawn>));

    const result = await runHardeningPass(ctx);

    expect(result.costUsd).toBeCloseTo(0.015);
  });
});
