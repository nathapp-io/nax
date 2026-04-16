/**
 * Integration test: Feature Engine v1 read path.
 *
 * Sets up a real temp directory with .nax/features/<id>/prd.json and context.md,
 * then verifies end-to-end feature context loading + role filtering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterContextByRole, truncateToContextBudget } from "../../../src/context/feature-context-filter";
import { FeatureContextProvider } from "../../../src/context/providers/feature-context";
import { clearFeatureResolverCache } from "../../../src/context/feature-resolver";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config/types";
import type { UserStory } from "../../../src/prd";
import { makeTempDir, cleanupTempDir } from "../../helpers/temp";

function makeStory(id: string): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makeConfig(enabled: boolean, budgetTokens = 2048): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    context: {
      ...DEFAULT_CONFIG.context,
      featureEngine: {
        enabled,
        budgetTokens,
      },
    },
  };
}

const CONTEXT_MD = `# Feature Context

_Last updated: 2024-01-01_

## Implementation Notes

- **Database schema defined.** \`[implementer]\`
  Use the schema in src/db/schema.ts.
  _Established in: US-001_

- **Test fixtures available.** \`[test-writer]\`
  Use the fixtures in test/fixtures/.
  _Established in: US-001_

- **Shared constraint.** \`[all]\`
  Always validate input before processing.
  _Established in: US-001_

## Review Notes

- **Security concern.** \`[reviewer-semantic]\`
  Check for SQL injection in all queries.
  _Established in: US-001_
`;

describe("Feature Engine v1 read path (integration)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-feat-engine-");
    clearFeatureResolverCache();

    // Set up .nax/features/auth-feature/prd.json
    const featDir = join(tempDir, ".nax", "features", "auth-feature");
    mkdirSync(featDir, { recursive: true });
    writeFileSync(
      join(featDir, "prd.json"),
      JSON.stringify({
        userStories: [
          { id: "US-001", title: "Implement auth" },
          { id: "US-002", title: "Add tests" },
        ],
      }),
    );
    writeFileSync(join(featDir, "context.md"), CONTEXT_MD);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    clearFeatureResolverCache();
  });

  test("disabled engine returns null", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(false);
    const result = await provider.getContext(story, tempDir, config);
    expect(result).toBeNull();
  });

  test("enabled engine with attached story returns FeatureContextResult", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, tempDir, config);

    expect(result).not.toBeNull();
    expect(result!.featureId).toBe("auth-feature");
    expect(result!.label).toBe("feature-context:auth-feature");
    expect(result!.content).toContain("## Feature Context");
    expect(result!.content).toContain("_Feature: auth-feature_");
    expect(result!.content).toContain("Database schema defined");
    expect(result!.estimatedTokens).toBeGreaterThan(0);
  });

  test("enabled engine with unattached story returns null", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-999"); // not in any feature prd.json
    const config = makeConfig(true);
    const result = await provider.getContext(story, tempDir, config);
    expect(result).toBeNull();
  });

  test("enabled engine without context.md returns null", async () => {
    const provider = new FeatureContextProvider();
    // Set up a second feature without context.md
    const featDir2 = join(tempDir, ".nax", "features", "empty-feature");
    mkdirSync(featDir2, { recursive: true });
    writeFileSync(
      join(featDir2, "prd.json"),
      JSON.stringify({
        userStories: [{ id: "US-010", title: "Story 010" }],
      }),
    );

    clearFeatureResolverCache();

    const story = makeStory("US-010");
    const config = makeConfig(true);
    const result = await provider.getContext(story, tempDir, config);
    expect(result).toBeNull();
  });

  test("role filtering: implementer sees [implementer] and [all], not [test-writer] or [reviewer-semantic]", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, tempDir, config);

    expect(result).not.toBeNull();
    const filtered = filterContextByRole(result!.content, "implementer");

    expect(filtered).toContain("Database schema defined");
    expect(filtered).toContain("Shared constraint");
    expect(filtered).not.toContain("Test fixtures available");
    expect(filtered).not.toContain("Security concern");
  });

  test("role filtering: test-writer sees [test-writer] and [all], not [implementer] or [reviewer-semantic]", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, tempDir, config);

    expect(result).not.toBeNull();
    const filtered = filterContextByRole(result!.content, "test-writer");

    expect(filtered).toContain("Test fixtures available");
    expect(filtered).toContain("Shared constraint");
    expect(filtered).not.toContain("Database schema defined");
    expect(filtered).not.toContain("Security concern");
  });

  test("role filtering: reviewer-semantic sees [reviewer-semantic] and [all], not [implementer] or [test-writer]", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true);
    const result = await provider.getContext(story, tempDir, config);

    expect(result).not.toBeNull();
    const filtered = filterContextByRole(result!.content, "reviewer-semantic");

    expect(filtered).toContain("Security concern");
    expect(filtered).toContain("Shared constraint");
    expect(filtered).not.toContain("Database schema defined");
    expect(filtered).not.toContain("Test fixtures available");
  });

  test("budget enforcement: truncate when filtered content exceeds budget", async () => {
    const provider = new FeatureContextProvider();
    const story = makeStory("US-001");
    const config = makeConfig(true, 10); // very small budget (10 tokens = 40 chars)
    const result = await provider.getContext(story, tempDir, config);

    expect(result).not.toBeNull();
    const filtered = filterContextByRole(result!.content, "implementer");
    const truncated = truncateToContextBudget(filtered, 10, result!.featureId);

    // Truncated should be shorter than filtered
    expect(truncated.length).toBeLessThan(filtered.length);
    expect(truncated.length).toBeGreaterThan(0);
  });
});
