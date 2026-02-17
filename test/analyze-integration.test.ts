/**
 * Integration Tests for Analyze Command
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { analyzeFeature } from "../src/cli/analyze";
import { DEFAULT_CONFIG } from "../src/config";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";

describe("analyzeFeature integration", () => {
  const testDir = "/tmp/ngent-analyze-test";
  const featureDir = join(testDir, "ngent/features/test-feature");

  beforeAll(() => {
    // Create test directory structure
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(featureDir, { recursive: true });

    // Create test tasks.md
    const tasksContent = `# Test Feature

## US-001: Add user authentication

### Description
Implement JWT-based authentication with refresh tokens.

### Acceptance Criteria
- [ ] User can log in with email/password
- [ ] JWT token is generated and stored
- [ ] Refresh token logic works
- [ ] Token expiry is handled

Tags: security, auth
Dependencies: none

## US-002: Update homepage UI

### Description
Refresh the homepage design with new color scheme.

### Acceptance Criteria
- [ ] New colors applied
- [ ] Layout is responsive

Tags: ui
Dependencies: none
`;

    Bun.write(join(featureDir, "tasks.md"), tasksContent);

    // Create mock src/ directory
    mkdirSync(join(testDir, "src"), { recursive: true });
    Bun.write(join(testDir, "src/index.ts"), "export {}");

    // Create mock package.json
    Bun.write(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "test-project",
        dependencies: { zod: "^4.0.0" },
        devDependencies: { typescript: "^5.0.0" },
      })
    );
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  test("parses tasks.md into PRD structure", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false, // Disable LLM for predictable tests
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const prd = await analyzeFeature(featureDir, "test-feature", "feat/test-feature", config);

    expect(prd.project).toBe("ngent");
    expect(prd.feature).toBe("test-feature");
    expect(prd.branchName).toBe("feat/test-feature");
    expect(prd.userStories).toHaveLength(2);
  });

  test("extracts story metadata correctly", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const prd = await analyzeFeature(featureDir, "test-feature", "feat/test-feature", config);

    const story1 = prd.userStories[0];
    expect(story1.id).toBe("US-001");
    expect(story1.title).toBe("Add user authentication");
    expect(story1.description).toContain("JWT-based authentication");
    expect(story1.acceptanceCriteria).toHaveLength(4);
    expect(story1.tags).toContain("security");
    expect(story1.tags).toContain("auth");
    expect(story1.status).toBe("pending");
    expect(story1.passes).toBe(false);
  });

  test("applies routing when LLM disabled (keyword fallback)", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const prd = await analyzeFeature(featureDir, "test-feature", "feat/test-feature", config);

    // Routing should not be applied when LLM is disabled
    expect(prd.userStories[0].routing).toBeUndefined();
    expect(prd.userStories[1].routing).toBeUndefined();
  });

  test("scans codebase when LLM enabled", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: true,
        classifierModel: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    // This will trigger LLM classification (will fall back due to no API key in test)
    const prd = await analyzeFeature(featureDir, "test-feature", "feat/test-feature", config);

    // Should have routing metadata from keyword fallback
    expect(prd.userStories[0].routing).toBeDefined();
    expect(prd.userStories[1].routing).toBeDefined();

    // First story should be complex (security keywords)
    expect(prd.userStories[0].routing?.complexity).toBe("complex");

    // Second story should be simple
    expect(prd.userStories[1].routing?.complexity).toBe("simple");
  });

  test("throws error when tasks.md missing", async () => {
    const emptyDir = "/tmp/ngent-empty-test";
    mkdirSync(emptyDir, { recursive: true });

    try {
      await expect(
        analyzeFeature(emptyDir, "empty", "feat/empty")
      ).rejects.toThrow("tasks.md not found");
    } finally {
      rmSync(emptyDir, { recursive: true });
    }
  });

  test("throws error when no stories found", async () => {
    const noStoriesDir = "/tmp/ngent-no-stories-test";
    const featurePath = join(noStoriesDir, "ngent/features/test");
    mkdirSync(featurePath, { recursive: true });

    // Create empty tasks.md
    await Bun.write(join(featurePath, "tasks.md"), "# Empty\n\nNo stories here.");

    try {
      await expect(
        analyzeFeature(featurePath, "test", "feat/test")
      ).rejects.toThrow("No user stories found");
    } finally {
      rmSync(noStoriesDir, { recursive: true });
    }
  });

  test("enforces maxStoriesPerFeature limit", async () => {
    const manyStoriesDir = "/tmp/ngent-many-stories-test";
    const featurePath = join(manyStoriesDir, "ngent/features/test");
    mkdirSync(featurePath, { recursive: true });

    // Create tasks.md with 600 stories (exceeds default limit of 500)
    let tasksContent = "# Many Stories\n\n";
    for (let i = 1; i <= 600; i++) {
      tasksContent += `## US-${String(i).padStart(3, "0")}: Story ${i}\n\n`;
      tasksContent += `### Description\nStory ${i}\n\n`;
      tasksContent += `### Acceptance Criteria\n- [ ] Done\n\n`;
    }
    await Bun.write(join(featurePath, "tasks.md"), tasksContent);

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxStoriesPerFeature: 500,
      },
    };

    try {
      await expect(
        analyzeFeature(featurePath, "test", "feat/test", config)
      ).rejects.toThrow("exceeding limit of 500");
    } finally {
      rmSync(manyStoriesDir, { recursive: true });
    }
  });
});
