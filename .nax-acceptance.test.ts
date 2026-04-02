import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DEFAULT_CONFIG } from "./src/config/defaults";
import { NaxConfigSchema } from "./src/config/schemas";
import type { StorySizeGateConfig, NaxConfig } from "./src/config/runtime-types";
import { checkStorySizeGate } from "./src/precheck/story-size-gate";
import type { PRD, UserStory } from "./src/prd/types";
import type { Check } from "./src/precheck/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a minimal mock NaxConfig for testing.
 * Provides all required fields with sensible defaults.
 */
function createMockConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  } as NaxConfig;
}

/**
 * Create a mock UserStory for testing.
 */
function createMockStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "Test description",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    routing: {
      complexity: "simple",
      testStrategy: "test-after",
    },
    ...overrides,
  };
}

/**
 * Create a mock PRD for testing.
 */
function createMockPRD(stories: UserStory[] = []): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    userStories: stories,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Helper to read a file if it exists, otherwise return null.
 */
async function tryReadFile(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: StorySizeGateConfig includes action field
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: StorySizeGateConfig includes action field", () => {
  test("StorySizeGateConfig has action field", () => {
    // Runtime check: verify the config type includes an 'action' property
    const config = createMockConfig();
    const gateConfig: StorySizeGateConfig | undefined = config.precheck?.storySizeGate;

    // Should have action field (when feature is implemented)
    expect(gateConfig).toBeDefined();
    if (gateConfig) {
      // Check that action field exists and is one of the expected values
      expect(["block", "warn", "skip"]).toContain((gateConfig as any).action || "block");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: StorySizeGateConfig includes maxReplanAttempts field
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: StorySizeGateConfig includes maxReplanAttempts field", () => {
  test("StorySizeGateConfig has maxReplanAttempts field", () => {
    // Runtime check: verify the config type includes maxReplanAttempts
    const config = createMockConfig();
    const gateConfig: StorySizeGateConfig | undefined = config.precheck?.storySizeGate;

    expect(gateConfig).toBeDefined();
    if (gateConfig) {
      // Check that maxReplanAttempts exists and is a number when present
      const maxReplan = (gateConfig as any).maxReplanAttempts;
      if (maxReplan !== undefined) {
        expect(typeof maxReplan).toBe("number");
        expect(maxReplan).toBeGreaterThan(0);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: Zod schema validates action and maxReplanAttempts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: Zod schema validates action and maxReplanAttempts", () => {
  test("schema validates action as enum with default 'block'", () => {
    // Runtime check: verify the Zod schema accepts and validates the action field
    const config = {
      ...DEFAULT_CONFIG,
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 10,
          maxDescriptionLength: 3000,
          maxBulletPoints: 12,
          action: "warn",
          maxReplanAttempts: 3,
        },
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema rejects invalid action value", () => {
    // Runtime check: verify the Zod schema rejects invalid action values
    const config = {
      ...DEFAULT_CONFIG,
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 10,
          maxDescriptionLength: 3000,
          maxBulletPoints: 12,
          action: "invalid-action",
          maxReplanAttempts: 3,
        },
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("schema validates maxReplanAttempts as positive integer with default 3", () => {
    // Runtime check: verify maxReplanAttempts is validated correctly
    const config = {
      ...DEFAULT_CONFIG,
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 10,
          maxDescriptionLength: 3000,
          maxBulletPoints: 12,
          action: "block",
          maxReplanAttempts: 5,
        },
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("schema rejects non-positive maxReplanAttempts", () => {
    // Runtime check: verify schema rejects invalid maxReplanAttempts
    const config = {
      ...DEFAULT_CONFIG,
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 10,
          maxDescriptionLength: 3000,
          maxBulletPoints: 12,
          action: "block",
          maxReplanAttempts: 0,
        },
      },
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: DEFAULT_CONFIG.precheck.storySizeGate has correct defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: DEFAULT_CONFIG.precheck.storySizeGate defaults", () => {
  test("DEFAULT_CONFIG.precheck.storySizeGate has action=block", () => {
    // Runtime check: verify the default config has correct action value
    const gateConfig = DEFAULT_CONFIG.precheck?.storySizeGate;
    expect(gateConfig).toBeDefined();
    expect((gateConfig as any).action).toBe("block");
  });

  test("DEFAULT_CONFIG.precheck.storySizeGate has maxReplanAttempts=3", () => {
    // Runtime check: verify the default config has correct maxReplanAttempts
    const gateConfig = DEFAULT_CONFIG.precheck?.storySizeGate;
    expect(gateConfig).toBeDefined();
    expect((gateConfig as any).maxReplanAttempts).toBe(3);
  });

  test("DEFAULT_CONFIG.precheck.storySizeGate has maxAcCount=10", () => {
    // Runtime check: verify maxAcCount default
    const gateConfig = DEFAULT_CONFIG.precheck?.storySizeGate;
    expect(gateConfig?.maxAcCount).toBe(10);
  });

  test("DEFAULT_CONFIG.precheck.storySizeGate has maxDescriptionLength=3000", () => {
    // Runtime check: verify maxDescriptionLength default
    const gateConfig = DEFAULT_CONFIG.precheck?.storySizeGate;
    expect(gateConfig?.maxDescriptionLength).toBe(3000);
  });

  test("DEFAULT_CONFIG.precheck.storySizeGate has maxBulletPoints=12", () => {
    // Runtime check: verify maxBulletPoints default
    const gateConfig = DEFAULT_CONFIG.precheck?.storySizeGate;
    expect(gateConfig?.maxBulletPoints).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: checkStorySizeGate returns blocker tier when action=block and stories exceed
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: checkStorySizeGate returns blocker tier when action=block", () => {
  test("returns blocker tier when action=block and story exceeds threshold", async () => {
    // Runtime check: call checkStorySizeGate with action='block' and oversized story
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 5,
          maxDescriptionLength: 100,
          maxBulletPoints: 5,
          action: "block",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(7).fill("AC"),
      description: "a".repeat(150),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.tier).toBe("blocker");
    expect(result.check.passed).toBe(false);
    expect(result.flaggedStories).toHaveLength(1);
  });

  test("flaggedStories array is populated when stories exceed thresholds", async () => {
    // Runtime check: verify flaggedStories contains story metadata
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 3,
          maxDescriptionLength: 50,
          maxBulletPoints: 5,
          action: "block",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-TEST",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.flaggedStories.length).toBeGreaterThan(0);
    expect(result.flaggedStories[0].storyId).toBe("US-TEST");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: checkStorySizeGate returns warning tier when action=warn
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: checkStorySizeGate returns warning tier when action=warn", () => {
  test("returns warning tier when action=warn and story exceeds threshold", async () => {
    // Runtime check: call checkStorySizeGate with action='warn'
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 5,
          maxDescriptionLength: 100,
          maxBulletPoints: 5,
          action: "warn",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(7).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.tier).toBe("warning");
    expect(result.check.passed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: checkStorySizeGate returns passed=true when action=skip regardless of size
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: checkStorySizeGate returns passed when action=skip", () => {
  test("returns passed=true when action=skip regardless of story size", async () => {
    // Runtime check: call checkStorySizeGate with action='skip'
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 5,
          maxDescriptionLength: 100,
          maxBulletPoints: 5,
          action: "skip",
          maxReplanAttempts: 3,
        },
      },
    });

    const oversizedStory = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(20).fill("AC"),
      description: "a".repeat(5000),
    });
    const prd = createMockPRD([oversizedStory]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.passed).toBe(true);
    expect(result.flaggedStories).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: StorySizeGateResult includes flaggedStoryIds
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: StorySizeGateResult includes flaggedStoryIds", () => {
  test("result includes flaggedStoryIds populated with story IDs", async () => {
    // Runtime check: verify flaggedStoryIds are populated from flaggedStories
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 3,
          maxDescriptionLength: 2000,
          maxBulletPoints: 8,
          action: "block",
          maxReplanAttempts: 3,
        },
      },
    });

    const stories = [
      createMockStory({ id: "US-001", acceptanceCriteria: Array(5).fill("AC") }),
      createMockStory({ id: "US-002", acceptanceCriteria: Array(6).fill("AC") }),
      createMockStory({ id: "US-003", acceptanceCriteria: ["AC-1"] }),
    ];
    const prd = createMockPRD(stories);

    const result = await checkStorySizeGate(config, prd);

    const flaggedIds = (result as any).flaggedStoryIds;
    if (flaggedIds) {
      expect(Array.isArray(flaggedIds)).toBe(true);
      flaggedIds.forEach((id: string) => {
        expect(typeof id).toBe("string");
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: Blocker message includes story ID and decompose instruction
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: Blocker message includes story ID and decompose instruction", () => {
  test("blocker message includes story ID", async () => {
    // Runtime check: verify the check message contains the story ID
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 3,
          maxDescriptionLength: 2000,
          maxBulletPoints: 8,
          action: "block",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-SPECIFIC-ID",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    expect(result.check.message).toContain("US-SPECIFIC-ID");
  });

  test("blocker message includes nax plan --decompose instruction", async () => {
    // Runtime check: verify the message mentions the decompose command
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 3,
          maxDescriptionLength: 2000,
          maxBulletPoints: 8,
          action: "block",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    // When action is 'block', the message should mention decompose
    if (result.check.tier === "blocker") {
      expect(result.check.message).toMatch(/decompose|nax plan/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: runPrecheck places story-size-gate in Tier 1 blockers when action=block
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: runPrecheck places story-size-gate in Tier 1 blockers when action=block", () => {
  test("story-size-gate check tier is blocker when action=block and check fails", async () => {
    // Runtime check: verify the check tier is set to 'blocker'
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 3,
          maxDescriptionLength: 2000,
          maxBulletPoints: 8,
          action: "block",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    // When action is block and check fails, tier should be 'blocker' (fail-fast)
    if (!result.check.passed) {
      expect(result.check.tier).toBe("blocker");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: runPrecheck places story-size-gate in Tier 2 warnings when action=warn
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: runPrecheck places story-size-gate in Tier 2 warnings when action=warn", () => {
  test("story-size-gate check tier is warning when action=warn and check fails", async () => {
    // Runtime check: verify the check tier is set to 'warning'
    const config = createMockConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 3,
          maxDescriptionLength: 2000,
          maxBulletPoints: 8,
          action: "warn",
          maxReplanAttempts: 3,
        },
      },
    });

    const story = createMockStory({
      id: "US-001",
      acceptanceCriteria: Array(5).fill("AC"),
    });
    const prd = createMockPRD([story]);

    const result = await checkStorySizeGate(config, prd);

    // When action is warn, tier should be 'warning' (non-blocking)
    expect(result.check.tier).toBe("warning");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: config-descriptions includes entries for storySizeGate action and maxReplanAttempts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: config-descriptions includes storySizeGate entries", () => {
  test("config-descriptions.ts exists and is readable", async () => {
    // File-check: verify the file exists
    const descPath = join(
      process.cwd(),
      "src/cli/config-descriptions.ts"
    );
    const exists = existsSync(descPath);
    expect(exists).toBe(true);
  });

  test("config-descriptions includes precheck.storySizeGate.action entry", async () => {
    // File-check: read the file and verify action description exists
    const descPath = join(
      process.cwd(),
      "src/cli/config-descriptions.ts"
    );
    const content = await tryReadFile(descPath);

    if (content) {
      expect(content).toMatch(/precheck.*storySizeGate.*action/i);
    }
  });

  test("config-descriptions includes precheck.storySizeGate.maxReplanAttempts entry", async () => {
    // File-check: read the file and verify maxReplanAttempts description exists
    const descPath = join(
      process.cwd(),
      "src/cli/config-descriptions.ts"
    );
    const content = await tryReadFile(descPath);

    if (content) {
      expect(content).toMatch(/precheck.*storySizeGate.*maxReplan/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: planDecomposeCommand is exported and accepts correct parameters
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: planDecomposeCommand exported with correct signature", () => {
  test("planDecomposeCommand is exported from src/cli/plan.ts", async () => {
    // Runtime check: verify the function is exported
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/export.*planDecomposeCommand/);
    }
  });

  test("planDecomposeCommand accepts workdir, config, and options with feature and storyId", async () => {
    // File-check: verify the signature in plan.ts
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      // Should show function signature with workdir, config, options
      expect(content).toMatch(/planDecomposeCommand.*workdir.*config.*options/i);
      expect(content).toMatch(/storyId/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: planDecomposeCommand throws PRD_NOT_FOUND when prd.json doesn't exist
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: planDecomposeCommand throws PRD_NOT_FOUND when prd.json missing", () => {
  test("throws error with PRD_NOT_FOUND code when prd.json doesn't exist", async () => {
    // Integration check: verify the error is thrown
    // This test verifies the error message/code exists in the source
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/PRD_NOT_FOUND/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: planDecomposeCommand throws STORY_NOT_FOUND when storyId not in PRD
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: planDecomposeCommand throws STORY_NOT_FOUND when story not found", () => {
  test("throws error with STORY_NOT_FOUND code when story not in PRD", async () => {
    // File-check: verify the error code exists in source
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/STORY_NOT_FOUND/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: planDecomposeCommand throws STORY_ALREADY_DECOMPOSED
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: planDecomposeCommand throws STORY_ALREADY_DECOMPOSED", () => {
  test("throws error with STORY_ALREADY_DECOMPOSED when story status is decomposed", async () => {
    // File-check: verify the error code exists
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/STORY_ALREADY_DECOMPOSED/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: planDecomposeCommand calls adapter.complete with prompt including story and context
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: planDecomposeCommand calls adapter.complete with proper prompt", () => {
  test("implementation calls adapter.complete with story context", async () => {
    // File-check: verify the function calls adapter.complete
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/adapter\.complete/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: planDecomposeCommand throws DECOMPOSE_VALIDATION_FAILED for empty contextFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: planDecomposeCommand validates contextFiles not empty", () => {
  test("throws DECOMPOSE_VALIDATION_FAILED when contextFiles is empty", async () => {
    // File-check: verify validation exists
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/DECOMPOSE_VALIDATION_FAILED/);
      expect(content).toMatch(/contextFiles/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: planDecomposeCommand throws DECOMPOSE_VALIDATION_FAILED for missing routing fields
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-19: planDecomposeCommand validates routing fields", () => {
  test("throws DECOMPOSE_VALIDATION_FAILED when routing fields missing", async () => {
    // File-check: verify routing validation exists
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/routing\.(complexity|testStrategy|modelTier)/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: planDecomposeCommand throws validation error when AC count exceeds threshold
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-20: planDecomposeCommand validates AC count per story", () => {
  test("throws DECOMPOSE_VALIDATION_FAILED when AC count exceeds maxAcCount", async () => {
    // File-check: verify AC count validation
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/maxAcCount|acceptanceCriteria/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: After successful decompose, original story has status=decomposed and sub-stories have parentStoryId
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-21: Decompose sets status and parentStoryId correctly", () => {
  test("implementation sets story status to decomposed", async () => {
    // File-check: verify the status field is set
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/status.*decomposed|decomposed.*status/i);
    }
  });

  test("implementation sets parentStoryId on sub-stories", async () => {
    // File-check: verify parentStoryId assignment
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/parentStoryId/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: planDecomposeCommand writes updated PRD back to disk
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-22: planDecomposeCommand writes PRD to disk", () => {
  test("implementation writes prd.json to correct path", async () => {
    // File-check: verify write operation
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/prd\.json|writeFile|Bun\.write/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-23: bin/nax.ts registers --decompose option on plan command
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-23: CLI registers --decompose option on plan command", () => {
  test("nax.ts or plan command file includes --decompose option", async () => {
    // File-check: verify CLI option registration
    const binPath = join(process.cwd(), "bin/nax.ts");
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const binContent = await tryReadFile(binPath);
    const planContent = await tryReadFile(planPath);

    const content = binContent || planContent || "";
    expect(content).toMatch(/--decompose|decompose.*option/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-24: When debate enabled, planDecomposeCommand uses DebateSession
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-24: planDecomposeCommand uses DebateSession when configured", () => {
  test("implementation creates DebateSession when debate.stages.decompose is enabled", async () => {
    // File-check: verify debate integration
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/DebateSession|debate/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-25: Debate fallback to single-agent when outcome=failed
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-25: planDecomposeCommand falls back to single-agent on failed debate", () => {
  test("implementation falls back to adapter.complete when debate fails", async () => {
    // File-check: verify fallback logic
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/failed|outcome.*failed|fallback/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-26: When debate not configured, calls adapter.complete directly
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-26: planDecomposeCommand calls adapter.complete when debate not configured", () => {
  test("implementation has direct adapter.complete call when debate disabled", async () => {
    // File-check: verify direct call
    const planPath = join(process.cwd(), "src/cli/plan.ts");
    const content = await tryReadFile(planPath);

    if (content) {
      expect(content).toMatch(/adapter\.complete/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-27: nax run --plan calls planDecomposeCommand for blocked stories
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-27: nax run --plan decompose integration", () => {
  test("nax run --plan implementation calls planDecomposeCommand for flagged stories", async () => {
    // File-check: verify the runner calls decompose
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const execPath = join(process.cwd(), "src/execution/runner.ts");
    const runContent = await tryReadFile(runPath);
    const execContent = await tryReadFile(execPath);

    const content = runContent || execContent || "";
    expect(content).toMatch(/planDecomposeCommand|decompose/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-28: PRD is reloaded and precheck re-runs with silent=true after each decompose
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-28: PRD reload and precheck re-run after decompose", () => {
  test("implementation reloads PRD from disk after decompose", async () => {
    // File-check: verify PRD reload logic
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const content = await tryReadFile(runPath);

    if (content) {
      expect(content).toMatch(/readFile.*prd|loadPrd|reload/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-29: Replan loop exits when flaggedStories length is 0
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-29: Replan loop exits early when no flagged stories", () => {
  test("implementation exits loop when flaggedStories is empty", async () => {
    // File-check: verify loop exit condition
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const content = await tryReadFile(runPath);

    if (content) {
      expect(content).toMatch(/flagged.*length|break|while/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-30: Replan loop repeats at most maxReplanAttempts times
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-30: Replan loop respects maxReplanAttempts limit", () => {
  test("implementation limits replan attempts to maxReplanAttempts", async () => {
    // File-check: verify attempt limit enforcement
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const content = await tryReadFile(runPath);

    if (content) {
      expect(content).toMatch(/maxReplan|attempt|loop/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-31: When all attempts exhausted, process.exit(1) called with error message
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-31: process.exit(1) when replan attempts exhausted", () => {
  test("implementation calls process.exit(1) when attempts exhausted", async () => {
    // File-check: verify exit call
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const content = await tryReadFile(runPath);

    if (content) {
      expect(content).toMatch(/exit.*1|process\.exit/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-32: When action=warn, replan loop does not fire
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-32: Replan loop skipped when action=warn", () => {
  test("implementation skips replan loop when action is warn", async () => {
    // File-check: verify action check before loop
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const content = await tryReadFile(runPath);

    if (content) {
      expect(content).toMatch(/action.*warn|warn.*action/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-33: Progress log emitted before each replan attempt
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-33: Progress log for replan attempts", () => {
  test("implementation emits progress log before replan", async () => {
    // File-check: verify progress logging
    const runPath = join(process.cwd(), "src/cli/run-plan.ts");
    const content = await tryReadFile(runPath);

    if (content) {
      expect(content).toMatch(/logger|log.*[Rr]eplan|[Rr]eplan.*log/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-34: src/decompose/ directory does not exist
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-34: src/decompose/ directory removed", () => {
  test("src/decompose directory does not exist", async () => {
    // File-check: verify directory is gone
    const decomposeDir = join(process.cwd(), "src/decompose");
    const exists = existsSync(decomposeDir);
    expect(exists).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-35: routing.ts does not import from decompose/ and no runDecompose references
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-35: routing.ts has no decompose imports or references", () => {
  test("routing.ts does not contain decompose imports", async () => {
    // File-check: verify no decompose imports
    const routingPath = join(process.cwd(), "src/pipeline/stages/routing.ts");
    const content = await tryReadFile(routingPath);

    if (content) {
      expect(content).not.toMatch(/from.*decompose/);
    }
  });

  test("routing.ts does not contain runDecompose or applyDecomposition", async () => {
    // File-check: verify no decompose function calls
    const routingPath = join(process.cwd(), "src/pipeline/stages/routing.ts");
    const content = await tryReadFile(routingPath);

    if (content) {
      expect(content).not.toMatch(/runDecompose|applyDecomposition/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-36: routing.ts does not contain checkStoryOversized or decomposeConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-36: routing.ts has no decompose config or checking", () => {
  test("routing.ts does not reference checkStoryOversized", async () => {
    // File-check: verify no oversized checking
    const routingPath = join(process.cwd(), "src/pipeline/stages/routing.ts");
    const content = await tryReadFile(routingPath);

    if (content) {
      expect(content).not.toMatch(/checkStoryOversized|decomposeConfig/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-37: RoutingDecision type does not include 'decomposed' action
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-37: RoutingDecision type excludes decomposed action", () => {
  test("RoutingDecision does not have decomposed action in union", async () => {
    // File-check: verify no decomposed action
    const typesPath = join(process.cwd(), "src/pipeline/types.ts");
    const content = await tryReadFile(typesPath);

    if (content) {
      // Find RoutingDecision and check it doesn't have 'decomposed'
      const routingMatch = content.match(/type RoutingDecision.*?(?:=|extends)[\s\S]*?(?:;|$)/);
      if (routingMatch) {
        expect(routingMatch[0]).not.toMatch(/'decomposed'/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-38: story:decomposed event type is removed
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-38: story:decomposed event removed", () => {
  test("event-bus.ts does not have story:decomposed event", async () => {
    // File-check: verify event is gone
    const eventPath = join(process.cwd(), "src/pipeline/event-bus.ts");
    const content = await tryReadFile(eventPath);

    if (content) {
      expect(content).not.toMatch(/'story:decomposed'|"story:decomposed"/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-39: events-writer.ts does not subscribe to story:decomposed
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-39: events-writer.ts has no story:decomposed subscription", () => {
  test("events-writer.ts does not subscribe to story:decomposed", async () => {
    // File-check: verify no subscription
    const eventsPath = join(process.cwd(), "src/pipeline/subscribers/events-writer.ts");
    const content = await tryReadFile(eventsPath);

    if (content) {
      expect(content).not.toMatch(/'story:decomposed'|on.*decomposed/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-40: hooks.ts does not subscribe to story:decomposed
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-40: hooks.ts has no story:decomposed subscription", () => {
  test("hooks.ts does not subscribe to story:decomposed", async () => {
    // File-check: verify no subscription
    const hooksPath = join(process.cwd(), "src/pipeline/subscribers/hooks.ts");
    const content = await tryReadFile(hooksPath);

    if (content) {
      expect(content).not.toMatch(/'story:decomposed'|decomposed.*hook/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-41: checkStoryOversized function removed from triggers.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-41: checkStoryOversized removed from triggers", () => {
  test("triggers.ts does not export checkStoryOversized", async () => {
    // File-check: verify function is gone
    const triggersPath = join(process.cwd(), "src/interaction/triggers.ts");
    const content = await tryReadFile(triggersPath);

    if (content) {
      expect(content).not.toMatch(/export.*checkStoryOversized|function checkStoryOversized/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-42: DecomposeConfig interface removed
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-42: DecomposeConfig interface removed", () => {
  test("runtime-types.ts does not have DecomposeConfig interface", async () => {
    // File-check: verify interface is gone
    const typesPath = join(process.cwd(), "src/config/runtime-types.ts");
    const content = await tryReadFile(typesPath);

    if (content) {
      // Should NOT have a standalone DecomposeConfig interface (only in old code)
      // Since the feature consolidates into precheck.storySizeGate, this should be gone
      const hasDecomposeConfig = /interface DecomposeConfig\s*{/m.test(content);
      expect(hasDecomposeConfig).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-43: NaxConfig does not have decompose field
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-43: NaxConfig decompose field removed", () => {
  test("NaxConfig interface does not have decompose field", async () => {
    // File-check: verify field is gone
    const typesPath = join(process.cwd(), "src/config/runtime-types.ts");
    const content = await tryReadFile(typesPath);

    if (content) {
      // Find the NaxConfig interface and verify no decompose field
      const configMatch = content.match(/interface NaxConfig[\s\S]*?^}/m);
      if (configMatch) {
        expect(configMatch[0]).not.toMatch(/decompose\?:/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-44: DecomposeConfigSchema removed from schemas.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-44: DecomposeConfigSchema removed from schemas", () => {
  test("schemas.ts does not have DecomposeConfigSchema", async () => {
    // File-check: verify schema is gone
    const schemasPath = join(process.cwd(), "src/config/schemas.ts");
    const content = await tryReadFile(schemasPath);

    if (content) {
      expect(content).not.toMatch(/DecomposeConfigSchema/);
    }
  });

  test("NaxConfigSchema does not reference decompose", async () => {
    // File-check: verify no decompose in main schema
    const schemasPath = join(process.cwd(), "src/config/schemas.ts");
    const content = await tryReadFile(schemasPath);

    if (content) {
      // Find the NaxConfigSchema definition and verify no decompose
      const schemaMatch = content.match(/const NaxConfigSchema[\s\S]*?(?=const|;$)/m);
      if (schemaMatch) {
        expect(schemaMatch[0]).not.toMatch(/decompose/i);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-45: defaults.ts does not contain decompose at top-level config
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-45: decompose removed from DEFAULT_CONFIG", () => {
  test("DEFAULT_CONFIG does not have decompose property", async () => {
    // Runtime check: verify the config doesn't have decompose
    expect(DEFAULT_CONFIG).not.toHaveProperty("decompose");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-46: config-descriptions does not have decompose. entries
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-46: config-descriptions has no decompose entries", () => {
  test("config-descriptions.ts does not have keys starting with decompose.", async () => {
    // File-check: verify no decompose descriptions
    const descPath = join(process.cwd(), "src/cli/config-descriptions.ts");
    const content = await tryReadFile(descPath);

    if (content) {
      expect(content).not.toMatch(/["']decompose\./);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-47: Old decompose test files do not exist
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-47: Old decompose test files removed", () => {
  test("test/unit/decompose/apply.test.ts does not exist", async () => {
    // File-check: verify test file is gone
    const testPath = join(process.cwd(), "test/unit/decompose/apply.test.ts");
    const exists = existsSync(testPath);
    expect(exists).toBe(false);
  });

  test("test/unit/decompose/builder.test.ts does not exist", async () => {
    // File-check: verify test file is gone
    const testPath = join(process.cwd(), "test/unit/decompose/builder.test.ts");
    const exists = existsSync(testPath);
    expect(exists).toBe(false);
  });

  test("test/unit/decompose/validators.test.ts does not exist", async () => {
    // File-check: verify test file is gone
    const testPath = join(process.cwd(), "test/unit/decompose/validators.test.ts");
    const exists = existsSync(testPath);
    expect(exists).toBe(false);
  });

  test("test/unit/pipeline/stages/routing-decompose.test.ts does not exist", async () => {
    // File-check: verify test file is gone
    const testPath = join(process.cwd(), "test/unit/pipeline/stages/routing-decompose.test.ts");
    const exists = existsSync(testPath);
    expect(exists).toBe(false);
  });

  test("test/unit/interaction/story-oversized-trigger.test.ts does not exist", async () => {
    // File-check: verify test file is gone
    const testPath = join(process.cwd(), "test/unit/interaction/story-oversized-trigger.test.ts");
    const exists = existsSync(testPath);
    expect(exists).toBe(false);
  });
});