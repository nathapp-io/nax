/**
 * US-004: Remove runtime decomposer and clean up all references
 *
 * These tests verify that all decompose-related code has been removed.
 * They are structured as static/structural assertions using file-content checks
 * and file-existence checks.
 *
 * All tests in this file FAIL before implementation and PASS after cleanup.
 */

import { describe, expect, test } from "bun:test";
import { join } from "path";

const ROOT = join(import.meta.dir, "../../..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fileContent(relPath: string): Promise<string> {
  return Bun.file(join(ROOT, relPath)).text();
}

async function fileExists(relPath: string): Promise<boolean> {
  return Bun.file(join(ROOT, relPath)).exists();
}

// ---------------------------------------------------------------------------
// AC1: src/decompose/ directory is fully removed
// ---------------------------------------------------------------------------

describe("AC1: src/decompose/ directory does not exist", () => {
  const decomposeFiles = [
    "src/decompose/index.ts",
    "src/decompose/types.ts",
    "src/decompose/apply.ts",
    "src/decompose/builder.ts",
    "src/decompose/codebase.ts",
    "src/decompose/constraints.ts",
    "src/decompose/sections/codebase.ts",
    "src/decompose/sections/constraints.ts",
    "src/decompose/sections/sibling-stories.ts",
    "src/decompose/sections/target-story.ts",
    "src/decompose/validators/complexity.ts",
    "src/decompose/validators/coverage.ts",
    "src/decompose/validators/dependency.ts",
    "src/decompose/validators/overlap.ts",
  ];

  for (const file of decomposeFiles) {
    test(`${file} does not exist`, async () => {
      expect(await fileExists(file)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// AC2: routing.ts has no decompose imports or function references
// ---------------------------------------------------------------------------

describe("AC2: src/pipeline/stages/routing.ts — decompose imports and functions removed", () => {
  const ROUTING = "src/pipeline/stages/routing.ts";

  test("does not import from ../../decompose/", async () => {
    const content = await fileContent(ROUTING);
    expect(content).not.toContain('from "../../decompose/');
    expect(content).not.toContain("from '../../decompose/");
  });

  test("does not contain runDecompose reference", async () => {
    const content = await fileContent(ROUTING);
    expect(content).not.toContain("runDecompose");
  });

  test("does not contain applyDecomposition reference", async () => {
    const content = await fileContent(ROUTING);
    expect(content).not.toContain("applyDecomposition");
  });
});

// ---------------------------------------------------------------------------
// AC3: routing.ts has no checkStoryOversized or decomposeConfig references
// ---------------------------------------------------------------------------

describe("AC3: src/pipeline/stages/routing.ts — oversized detection removed", () => {
  const ROUTING = "src/pipeline/stages/routing.ts";

  test("does not contain checkStoryOversized reference", async () => {
    const content = await fileContent(ROUTING);
    expect(content).not.toContain("checkStoryOversized");
  });

  test("does not contain decomposeConfig reference", async () => {
    const content = await fileContent(ROUTING);
    expect(content).not.toContain("decomposeConfig");
  });
});

// ---------------------------------------------------------------------------
// AC4: RoutingDecision / StageAction does not include 'decomposed' action
// ---------------------------------------------------------------------------

describe("AC4: src/pipeline/types.ts — decomposed action removed from StageAction union", () => {
  test("does not contain decomposed action variant", async () => {
    const content = await fileContent("src/pipeline/types.ts");
    expect(content).not.toContain('"decomposed"');
    expect(content).not.toContain("'decomposed'");
  });

  test("does not contain story:decomposed comment or reference in types", async () => {
    const content = await fileContent("src/pipeline/types.ts");
    expect(content).not.toContain("story:decomposed");
    expect(content).not.toContain("decomposed into sub-stories");
  });
});

// ---------------------------------------------------------------------------
// AC5: story:decomposed event type removed from event-bus.ts
// ---------------------------------------------------------------------------

describe("AC5: src/pipeline/event-bus.ts — story:decomposed event removed", () => {
  test("does not define StoryDecomposedEvent interface", async () => {
    const content = await fileContent("src/pipeline/event-bus.ts");
    expect(content).not.toContain("StoryDecomposedEvent");
  });

  test("does not include story:decomposed in PipelineEvent union", async () => {
    const content = await fileContent("src/pipeline/event-bus.ts");
    expect(content).not.toContain("story:decomposed");
  });
});

// ---------------------------------------------------------------------------
// AC6: events-writer.ts does not subscribe to story:decomposed
// ---------------------------------------------------------------------------

describe("AC6: src/pipeline/subscribers/events-writer.ts — story:decomposed handler removed", () => {
  test("does not contain story:decomposed subscription", async () => {
    const content = await fileContent("src/pipeline/subscribers/events-writer.ts");
    expect(content).not.toContain("story:decomposed");
  });
});

// ---------------------------------------------------------------------------
// AC7: hooks.ts does not subscribe to story:decomposed
// ---------------------------------------------------------------------------

describe("AC7: src/pipeline/subscribers/hooks.ts — story:decomposed handler removed", () => {
  test("does not contain story:decomposed subscription", async () => {
    const content = await fileContent("src/pipeline/subscribers/hooks.ts");
    expect(content).not.toContain("story:decomposed");
  });
});

// ---------------------------------------------------------------------------
// AC8: checkStoryOversized removed from triggers.ts
// ---------------------------------------------------------------------------

describe("AC8: src/interaction/triggers.ts — checkStoryOversized removed", () => {
  test("does not export or define checkStoryOversized", async () => {
    const content = await fileContent("src/interaction/triggers.ts");
    expect(content).not.toContain("checkStoryOversized");
  });

  test("does not reference story-oversized trigger", async () => {
    const content = await fileContent("src/interaction/triggers.ts");
    expect(content).not.toContain("story-oversized");
  });
});

// ---------------------------------------------------------------------------
// AC9 & AC10: DecomposeConfig and NaxConfig.decompose? removed from runtime-types.ts
// ---------------------------------------------------------------------------

describe("AC9-AC10: src/config/runtime-types.ts — DecomposeConfig and NaxConfig.decompose removed", () => {
  test("does not define DecomposeConfig interface", async () => {
    const content = await fileContent("src/config/runtime-types.ts");
    expect(content).not.toContain("DecomposeConfig");
  });

  test("NaxConfig does not contain decompose field", async () => {
    const content = await fileContent("src/config/runtime-types.ts");
    // Match "decompose?" or "decompose :" field in interface
    expect(content).not.toMatch(/decompose\s*\??:/);
  });
});

// ---------------------------------------------------------------------------
// AC11: DecomposeConfigSchema removed from schemas.ts
// ---------------------------------------------------------------------------

describe("AC11: src/config/schemas.ts — DecomposeConfigSchema removed", () => {
  test("does not define DecomposeConfigSchema", async () => {
    const content = await fileContent("src/config/schemas.ts");
    expect(content).not.toContain("DecomposeConfigSchema");
  });

  test("main config schema does not reference decompose", async () => {
    const content = await fileContent("src/config/schemas.ts");
    expect(content).not.toMatch(/decompose\s*:/);
  });
});

// ---------------------------------------------------------------------------
// AC12: defaults.ts does not contain decompose key
// ---------------------------------------------------------------------------

describe("AC12: src/config/defaults.ts — decompose defaults removed", () => {
  test("does not contain top-level decompose key", async () => {
    const content = await fileContent("src/config/defaults.ts");
    expect(content).not.toMatch(/\bdecompose\s*:/);
  });
});

// ---------------------------------------------------------------------------
// AC13: config-descriptions.ts has no decompose.* entries
// ---------------------------------------------------------------------------

describe("AC13: src/cli/config-descriptions.ts — decompose.* entries removed", () => {
  test("does not contain any keys starting with decompose.", async () => {
    const content = await fileContent("src/cli/config-descriptions.ts");
    expect(content).not.toMatch(/"decompose\./);
    expect(content).not.toMatch(/'decompose\./);
  });

  test("does not contain the top-level decompose description entry", async () => {
    const content = await fileContent("src/cli/config-descriptions.ts");
    // Match "decompose": or 'decompose':
    expect(content).not.toMatch(/["']decompose["']\s*:/);
  });
});

// ---------------------------------------------------------------------------
// AC14: decompose-related test files do not exist
// ---------------------------------------------------------------------------

describe("AC14: decompose-related test files are deleted", () => {
  const deletedTestFiles = [
    "test/unit/decompose/apply.test.ts",
    "test/unit/decompose/builder.test.ts",
    "test/unit/decompose/validators.test.ts",
    "test/unit/pipeline/stages/routing-decompose.test.ts",
    "test/unit/interaction/story-oversized-trigger.test.ts",
  ];

  for (const file of deletedTestFiles) {
    test(`${file} does not exist`, async () => {
      expect(await fileExists(file)).toBe(false);
    });
  }
});
