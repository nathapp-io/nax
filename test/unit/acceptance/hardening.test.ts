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

    _hardeningDeps.refine = mock(async (criteria: string[]) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" })),
    );
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [{ id: "AC-1", text: "suggested edge case", lineNumber: 1 }],
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

    _hardeningDeps.refine = mock(async (criteria: string[]) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" })),
    );
    _hardeningDeps.generate = mock(async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [{ id: "AC-1", text: "failing edge case", lineNumber: 1 }],
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
});
