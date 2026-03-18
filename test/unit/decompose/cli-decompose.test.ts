/**
 * CLI Decompose Entry Point — SD-004
 *
 * Tests for --decompose <storyId> and --decompose-oversized flags.
 *
 * Tests are RED until the CLI functions are implemented.
 *
 * Expected exports from src/cli/analyze.ts (or src/cli/analyze-decompose.ts):
 *   - decomposeStory(storyId, options)
 *   - decomposeOversized(options)
 *
 * Each function uses _decomposeCLIDeps for dependency injection.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PRD, UserStory } from "../../../src/prd";
import type { DecomposeResult } from "../../../src/decompose/types";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { NaxConfig } from "../../../src/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, acCount: number, complexity = "complex"): UserStory {
  const acs: string[] = [];
  for (let i = 1; i <= acCount; i++) {
    acs.push(`AC-${i}`);
  }
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: acs,
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    routing: {
      complexity: complexity as import("../../../src/config").Complexity,
      testStrategy: "three-session-tdd",
      reasoning: "classified",
    },
  };
}

function makePRD(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeConfig(decomposeOverrides?: Partial<NaxConfig["decompose"]>): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    decompose: {
      trigger: "auto",
      maxAcceptanceCriteria: 6,
      maxSubstories: 5,
      maxSubstoryComplexity: "medium",
      maxRetries: 2,
      model: "balanced",
      ...decomposeOverrides,
    },
  };
}

function makeDecomposeResult(parentId: string): DecomposeResult {
  return {
    subStories: [
      {
        id: `${parentId}-1`,
        parentStoryId: parentId,
        title: "Sub-story 1",
        description: "First part",
        acceptanceCriteria: ["Implement login flow", "Add retry logic", "Validate user input"],
        tags: [],
        dependencies: [],
        complexity: "medium",
        nonOverlapJustification: "Handles part 1 only",
      },
      {
        id: `${parentId}-2`,
        parentStoryId: parentId,
        title: "Sub-story 2",
        description: "Second part",
        acceptanceCriteria: ["Handle error states", "Add pagination"],
        tags: [],
        dependencies: [`${parentId}-1`],
        complexity: "simple",
        nonOverlapJustification: "Handles part 2 only",
      },
    ],
    validation: { valid: true, errors: [], warnings: [] },
  };
}

// ---------------------------------------------------------------------------
// Module existence: decomposeStory and decomposeOversized must be exported
// ---------------------------------------------------------------------------

describe("CLI decompose exports exist", () => {
  test("decomposeStory is exported from src/cli/analyze.ts", async () => {
    const mod = await import("../../../src/cli/analyze");
    expect(typeof (mod as Record<string, unknown>).decomposeStory).toBe("function");
  });

  test("decomposeOversized is exported from src/cli/analyze.ts", async () => {
    const mod = await import("../../../src/cli/analyze");
    expect(typeof (mod as Record<string, unknown>).decomposeOversized).toBe("function");
  });

  test("_decomposeCLIDeps is exported from src/cli/analyze.ts for dependency injection", async () => {
    const mod = await import("../../../src/cli/analyze");
    expect(typeof (mod as Record<string, unknown>)._decomposeCLIDeps).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// decomposeStory — single story decomposition via --decompose <storyId>
// ---------------------------------------------------------------------------

describe("decomposeStory", () => {
  let origDeps: unknown;

  afterEach(() => {
    mock.restore();
    if (origDeps) {
      const mod = require("../../../src/cli/analyze");
      if (mod._decomposeCLIDeps) {
        Object.assign(mod._decomposeCLIDeps, origDeps);
      }
    }
  });

  test("loads PRD, finds story by ID, decomposes, and saves PRD", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const story = makeStory("US-003", 8);
    const prd = makePRD([story]);

    const loadPRDMock = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    const runDecomposeMock = mock(() => Promise.resolve(makeDecomposeResult("US-003")));
    const applyMock = mock(() => {});
    const savePRDMock = mock(() => Promise.resolve());

    deps.loadPRD = loadPRDMock;
    deps.runDecompose = runDecomposeMock;
    deps.applyDecomposition = applyMock;
    deps.savePRD = savePRDMock;

    const { decomposeStory } = mod as Record<string, unknown> as {
      decomposeStory: (storyId: string, options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await decomposeStory("US-003", { featureDir: "/tmp/nax", config: makeConfig() });

    expect(loadPRDMock).toHaveBeenCalled();
    expect(runDecomposeMock).toHaveBeenCalled();
    expect(applyMock).toHaveBeenCalledWith(prd, expect.objectContaining({ subStories: expect.any(Array) }));
    expect(savePRDMock).toHaveBeenCalledWith(prd, "/tmp/nax/prd.json");
  });

  test("throws when story ID is not found in PRD", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const prd = makePRD([makeStory("US-001", 3)]);
    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = mock(() => Promise.resolve(makeDecomposeResult("US-999")));
    deps.applyDecomposition = mock(() => {});
    deps.savePRD = mock(() => Promise.resolve());

    const { decomposeStory } = mod as Record<string, unknown> as {
      decomposeStory: (storyId: string, options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await expect(
      decomposeStory("US-999", { featureDir: "/tmp/nax", config: makeConfig() }),
    ).rejects.toThrow(/US-999/);
  });

  test("prints summary table with substory IDs, titles, and complexity", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const story = makeStory("US-003", 8);
    const prd = makePRD([story]);
    const decomposeResult = makeDecomposeResult("US-003");

    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = mock(() => Promise.resolve(decomposeResult));
    deps.applyDecomposition = mock(() => {});
    deps.savePRD = mock(() => Promise.resolve());

    const printedLines: string[] = [];
    deps.printSummary = mock((lines: string[]) => {
      printedLines.push(...lines);
    });

    const { decomposeStory } = mod as Record<string, unknown> as {
      decomposeStory: (storyId: string, options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await decomposeStory("US-003", { featureDir: "/tmp/nax", config: makeConfig() });

    // Summary should reference the substory IDs
    const allOutput = printedLines.join("\n");
    expect(allOutput).toContain("US-003-1");
    expect(allOutput).toContain("US-003-2");
  });

  test("does not save PRD when decompose returns invalid result", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const story = makeStory("US-003", 8);
    const prd = makePRD([story]);

    const savePRDMock = mock(() => Promise.resolve());
    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = mock(() =>
      Promise.resolve({
        subStories: [],
        validation: { valid: false, errors: ["Failed after retries"], warnings: [] },
      } as DecomposeResult),
    );
    deps.applyDecomposition = mock(() => {});
    deps.savePRD = savePRDMock;

    const { decomposeStory } = mod as Record<string, unknown> as {
      decomposeStory: (storyId: string, options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    // Should not throw, but should warn
    await decomposeStory("US-003", { featureDir: "/tmp/nax", config: makeConfig() });

    expect(savePRDMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// decomposeOversized — bulk decompose all stories exceeding threshold
// ---------------------------------------------------------------------------

describe("decomposeOversized", () => {
  let origDeps: unknown;

  afterEach(() => {
    mock.restore();
    if (origDeps) {
      const mod = require("../../../src/cli/analyze");
      if (mod._decomposeCLIDeps) {
        Object.assign(mod._decomposeCLIDeps, origDeps);
      }
    }
  });

  test("decomposes all stories with ACs exceeding threshold and complex/expert complexity", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const oversized1 = makeStory("US-001", 8, "complex");  // 8 ACs > 6 → decompose
    const oversized2 = makeStory("US-002", 10, "expert");  // 10 ACs > 6 → decompose
    const normal = makeStory("US-003", 3, "simple");        // 3 ACs < 6 → skip
    const prd = makePRD([oversized1, oversized2, normal]);

    const runDecomposeMock = mock((story: UserStory) =>
      Promise.resolve(makeDecomposeResult(story.id)),
    );
    const applyMock = mock(() => {});
    const savePRDMock = mock(() => Promise.resolve());

    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = runDecomposeMock;
    deps.applyDecomposition = applyMock;
    deps.savePRD = savePRDMock;

    const { decomposeOversized } = mod as Record<string, unknown> as {
      decomposeOversized: (options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await decomposeOversized({ featureDir: "/tmp/nax", config: makeConfig({ maxAcceptanceCriteria: 6 }) });

    // Should decompose 2 oversized stories, skip 1 normal
    expect(runDecomposeMock).toHaveBeenCalledTimes(2);
    expect(applyMock).toHaveBeenCalledTimes(2);
    // PRD saved once after all decompositions
    expect(savePRDMock).toHaveBeenCalled();
  });

  test("skips stories below threshold", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const normal1 = makeStory("US-001", 2, "complex");  // 2 ACs < 6 → skip
    const normal2 = makeStory("US-002", 5, "expert");   // 5 ACs < 6 → skip
    const prd = makePRD([normal1, normal2]);

    const runDecomposeMock = mock(() => Promise.resolve(makeDecomposeResult("US-001")));
    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = runDecomposeMock;
    deps.applyDecomposition = mock(() => {});
    deps.savePRD = mock(() => Promise.resolve());

    const { decomposeOversized } = mod as Record<string, unknown> as {
      decomposeOversized: (options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await decomposeOversized({ featureDir: "/tmp/nax", config: makeConfig({ maxAcceptanceCriteria: 6 }) });

    // No stories exceed threshold → no decompose calls
    expect(runDecomposeMock).not.toHaveBeenCalled();
  });

  test("prints summary table of all decomposed stories", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    const oversized = makeStory("US-001", 9, "complex");
    const prd = makePRD([oversized]);

    const printedLines: string[] = [];
    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = mock(() => Promise.resolve(makeDecomposeResult("US-001")));
    deps.applyDecomposition = mock(() => {});
    deps.savePRD = mock(() => Promise.resolve());
    deps.printSummary = mock((lines: string[]) => {
      printedLines.push(...lines);
    });

    const { decomposeOversized } = mod as Record<string, unknown> as {
      decomposeOversized: (options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await decomposeOversized({ featureDir: "/tmp/nax", config: makeConfig() });

    const allOutput = printedLines.join("\n");
    // Summary should reference original story and substories
    expect(allOutput).toContain("US-001");
    expect(allOutput).toContain("US-001-1");
    expect(allOutput).toContain("US-001-2");
  });

  test("skips stories with medium or simpler complexity even if ACs exceed threshold", async () => {
    const mod = await import("../../../src/cli/analyze");
    const deps = (mod as Record<string, unknown>)._decomposeCLIDeps as Record<string, unknown>;
    origDeps = { ...deps };

    // Many ACs but only medium complexity → should not decompose
    const mediumStory = makeStory("US-001", 10, "medium");
    const prd = makePRD([mediumStory]);

    const runDecomposeMock = mock(() => Promise.resolve(makeDecomposeResult("US-001")));
    deps.loadPRD = mock(() => Promise.resolve({ prd, prdPath: "/tmp/nax/prd.json" }));
    deps.runDecompose = runDecomposeMock;
    deps.applyDecomposition = mock(() => {});
    deps.savePRD = mock(() => Promise.resolve());

    const { decomposeOversized } = mod as Record<string, unknown> as {
      decomposeOversized: (options: { featureDir: string; config: NaxConfig }) => Promise<void>;
    };

    await decomposeOversized({ featureDir: "/tmp/nax", config: makeConfig({ maxAcceptanceCriteria: 6 }) });

    expect(runDecomposeMock).not.toHaveBeenCalled();
  });
});
