/**
 * Integration Tests for Analyze Command
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { analyzeFeature } from "../src/cli/analyze";
import { DEFAULT_CONFIG } from "../src/config";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";

describe("analyzeFeature integration", () => {
  const testDir = "/tmp/nax-analyze-test";
  const featureDir = join(testDir, "nax/features/test-feature");

  beforeAll(() => {
    // Create test directory structure
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    mkdirSync(featureDir, { recursive: true });

    // Create test spec.md
    const specContent = `# Test Feature

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

    Bun.write(join(featureDir, "spec.md"), specContent);

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

  test("parses spec.md into PRD structure", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false, // Disable LLM for predictable tests
        model: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const prd = await analyzeFeature({
      featureDir,
      featureName: "test-feature",
      branchName: "feat/test-feature",
      config,
    });

    expect(prd.project).toBe("nax");
    expect(prd.feature).toBe("test-feature");
    expect(prd.branchName).toBe("feat/test-feature");
    expect(prd.userStories).toHaveLength(2);
  });

  test("extracts story metadata correctly", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: false,
        model: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const prd = await analyzeFeature({
      featureDir,
      featureName: "test-feature",
      branchName: "feat/test-feature",
      config,
    });

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
        model: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    const prd = await analyzeFeature({
      featureDir,
      featureName: "test-feature",
      branchName: "feat/test-feature",
      config,
    });

    // Routing should be applied with keyword classification
    expect(prd.userStories[0].routing).toBeDefined();
    expect(prd.userStories[1].routing).toBeDefined();
  });

  test.skip("scans codebase when LLM enabled", async () => {
    // Skipped: This test would require a real agent installation and API key
    // The LLM decompose flow is tested in unit tests with mocked agents
    const config = {
      ...DEFAULT_CONFIG,
      analyze: {
        llmEnhanced: true,
        model: "fast" as const,
        fallbackToKeywords: true,
        maxCodebaseSummaryTokens: 5000,
      },
    };

    // This will trigger LLM decompose (will fall back due to no agent in test)
    const prd = await analyzeFeature({
      featureDir,
      featureName: "test-feature",
      branchName: "feat/test-feature",
      config,
    });

    // Should have routing metadata from keyword fallback
    expect(prd.userStories[0].routing).toBeDefined();
    expect(prd.userStories[1].routing).toBeDefined();

    // First story should be complex (security keywords)
    expect(prd.userStories[0].routing?.complexity).toBe("complex");

    // Second story should be simple
    expect(prd.userStories[1].routing?.complexity).toBe("simple");
  });

  test("throws error when spec.md missing", async () => {
    const emptyDir = "/tmp/nax-empty-test";
    mkdirSync(emptyDir, { recursive: true });

    try {
      await expect(
        analyzeFeature({
          featureDir: emptyDir,
          featureName: "empty",
          branchName: "feat/empty",
        })
      ).rejects.toThrow("spec.md not found");
    } finally {
      rmSync(emptyDir, { recursive: true });
    }
  });

  test("throws error when no stories found", async () => {
    const noStoriesDir = "/tmp/nax-no-stories-test";
    const featurePath = join(noStoriesDir, "nax/features/test");
    mkdirSync(featurePath, { recursive: true });

    // Create empty spec.md
    await Bun.write(join(featurePath, "spec.md"), "# Empty\n\nNo stories here.");

    try {
      await expect(
        analyzeFeature({
          featureDir: featurePath,
          featureName: "test",
          branchName: "feat/test",
        })
      ).rejects.toThrow("No user stories found");
    } finally {
      rmSync(noStoriesDir, { recursive: true });
    }
  });

  test("warns but succeeds when story count exceeds maxStoriesPerFeature limit", async () => {
    const manyStoriesDir = "/tmp/nax-many-stories-test";
    const featurePath = join(manyStoriesDir, "nax/features/test");
    mkdirSync(featurePath, { recursive: true });

    // Create spec.md with 6 stories (exceeds limit of 5)
    let specContent = "# Many Stories\n\n";
    for (let i = 1; i <= 6; i++) {
      specContent += `## US-${String(i).padStart(3, "0")}: Story ${i}\n\n`;
      specContent += `### Description\nStory ${i}\n\n`;
      specContent += `### Acceptance Criteria\n- [ ] Done\n\n`;
    }
    await Bun.write(join(featurePath, "spec.md"), specContent);

    const config = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxStoriesPerFeature: 5,
      },
      analyze: {
        ...DEFAULT_CONFIG.analyze,
        llmEnhanced: false,
      },
    };

    try {
      // Should warn but not throw (changed from hard error to warning)
      const prd = await analyzeFeature({
        featureDir: featurePath,
        featureName: "test",
        branchName: "feat/test",
        config,
      });
      expect(prd.userStories.length).toBe(6);
    } finally {
      rmSync(manyStoriesDir, { recursive: true });
    }
  });
});
