import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { analyzeFeature } from "../../../src/cli/analyze";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/schema";

describe("analyzeFeature", () => {
  test("parses spec.md into user stories (LLM disabled, keyword fallback)", async () => {
    const tmpDir = `/tmp/nax-analyze-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    await Bun.write(
      `${tmpDir}/spec.md`,
      `# Feature: Auth System

## US-001: Add login endpoint

### Description
Create a POST /auth/login endpoint that accepts email and password.

### Acceptance Criteria
- [ ] Endpoint returns JWT token on success
- [ ] Returns 401 on invalid credentials
- [ ] Rate limited to 5 attempts per minute

Tags: security, auth
Dependencies: US-000

## US-002: Add logout endpoint

### Description
Create a POST /auth/logout endpoint.

### Acceptance Criteria
- [ ] Invalidates the current token
- [ ] Returns 200 on success

Dependencies: US-001
`,
    );

    // Disable LLM for keyword-based classification
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      analyze: {
        ...DEFAULT_CONFIG.analyze,
        llmEnhanced: false,
      },
    };

    const prd = await analyzeFeature({
      featureDir: tmpDir,
      featureName: "auth",
      branchName: "feat/auth",
      config,
    });

    expect(prd.feature).toBe("auth");
    expect(prd.branchName).toBe("feat/auth");
    expect(prd.userStories).toHaveLength(2);

    const s1 = prd.userStories[0];
    expect(s1.id).toBe("US-001");
    expect(s1.title).toBe("Add login endpoint");
    expect(s1.acceptanceCriteria).toHaveLength(3);
    expect(s1.tags).toContain("security");
    expect(s1.dependencies).toContain("US-000");

    const s2 = prd.userStories[1];
    expect(s2.id).toBe("US-002");
    expect(s2.title).toBe("Add logout endpoint");
    expect(s2.acceptanceCriteria).toHaveLength(2);
    expect(s2.dependencies).toContain("US-001");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("throws when spec.md is missing", async () => {
    const tmpDir = `/tmp/nax-analyze-empty-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    await expect(
      analyzeFeature({
        featureDir: tmpDir,
        featureName: "test",
        branchName: "feat/test",
      }),
    ).rejects.toThrow("spec.md not found");

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("warns but does not throw when story count exceeds maxStoriesPerFeature limit", async () => {
    const tmpDir = `/tmp/nax-analyze-limit-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    // Generate spec.md with 6 stories
    const stories = Array.from(
      { length: 6 },
      (_, i) => `
## US-${String(i + 1).padStart(3, "0")}: Story ${i + 1}

### Description
Description for story ${i + 1}

### Acceptance Criteria
- [ ] Criterion 1
`,
    ).join("\n");

    await Bun.write(`${tmpDir}/spec.md`, `# Feature\n${stories}`);

    // Create config with limit of 5 stories (LLM disabled)
    const config: NaxConfig = {
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

    // Should warn but still succeed (no longer throws)
    const prd = await analyzeFeature({
      featureDir: tmpDir,
      featureName: "test",
      branchName: "feat/test",
      config,
    });

    expect(prd.userStories.length).toBe(6);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("allows story count at maxStoriesPerFeature limit", async () => {
    const tmpDir = `/tmp/nax-analyze-ok-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    // Generate spec.md with exactly 5 stories
    const stories = Array.from(
      { length: 5 },
      (_, i) => `
## US-${String(i + 1).padStart(3, "0")}: Story ${i + 1}

### Description
Description for story ${i + 1}

### Acceptance Criteria
- [ ] Criterion 1
`,
    ).join("\n");

    await Bun.write(`${tmpDir}/spec.md`, `# Feature\n${stories}`);

    // Create config with limit of 5 stories (LLM disabled)
    const config: NaxConfig = {
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

    // Should NOT throw because 5 === 5
    const prd = await analyzeFeature({
      featureDir: tmpDir,
      featureName: "test",
      branchName: "feat/test",
      config,
    });
    expect(prd.userStories).toHaveLength(5);

    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads spec from explicit --from path", async () => {
    const tmpDir = `/tmp/nax-analyze-from-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });

    const customSpecPath = `${tmpDir}/custom-spec.md`;
    await Bun.write(
      customSpecPath,
      `# Custom Spec

## US-001: Custom story

### Description
A custom story from explicit path

### Acceptance Criteria
- [ ] Works with --from flag
`,
    );

    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      analyze: {
        ...DEFAULT_CONFIG.analyze,
        llmEnhanced: false,
      },
    };

    const prd = await analyzeFeature({
      featureDir: tmpDir,
      featureName: "custom",
      branchName: "feat/custom",
      config,
      specPath: customSpecPath,
    });

    expect(prd.userStories).toHaveLength(1);
    expect(prd.userStories[0].id).toBe("US-001");
    expect(prd.userStories[0].title).toBe("Custom story");

    await rm(tmpDir, { recursive: true, force: true });
  });
});
