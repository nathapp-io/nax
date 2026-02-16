import { describe, expect, test } from "bun:test";
import { analyzeFeature } from "../src/cli/analyze";
import { DEFAULT_CONFIG } from "../src/config/schema";
import type { NgentConfig } from "../src/config";

describe("analyzeFeature", () => {
  test("parses tasks.md into user stories", async () => {
    const tmpDir = `/tmp/ngent-analyze-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;

    await Bun.write(`${tmpDir}/tasks.md`, `# Tasks: auth

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
`);

    const prd = await analyzeFeature(tmpDir, "auth", "feat/auth");

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

    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("throws when tasks.md is missing", async () => {
    const tmpDir = `/tmp/ngent-analyze-empty-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;

    expect(analyzeFeature(tmpDir, "test", "feat/test")).rejects.toThrow("tasks.md not found");

    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("throws when story count exceeds maxStoriesPerFeature limit (MEM-1)", async () => {
    const tmpDir = `/tmp/ngent-analyze-limit-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;

    // Generate tasks.md with 6 stories
    const stories = Array.from({ length: 6 }, (_, i) => `
## US-${String(i + 1).padStart(3, "0")}: Story ${i + 1}

### Description
Description for story ${i + 1}

### Acceptance Criteria
- [ ] Criterion 1
`).join("\n");

    await Bun.write(`${tmpDir}/tasks.md`, `# Tasks\n${stories}`);

    // Create config with limit of 5 stories
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxStoriesPerFeature: 5,
      },
    };

    // Should throw because 6 > 5
    await expect(analyzeFeature(tmpDir, "test", "feat/test", config)).rejects.toThrow(
      /Feature has 6 stories, exceeding limit of 5/
    );

    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });

  test("allows story count at maxStoriesPerFeature limit", async () => {
    const tmpDir = `/tmp/ngent-analyze-ok-${Date.now()}`;
    await Bun.spawn(["mkdir", "-p", tmpDir], { stdout: "pipe" }).exited;

    // Generate tasks.md with exactly 5 stories
    const stories = Array.from({ length: 5 }, (_, i) => `
## US-${String(i + 1).padStart(3, "0")}: Story ${i + 1}

### Description
Description for story ${i + 1}

### Acceptance Criteria
- [ ] Criterion 1
`).join("\n");

    await Bun.write(`${tmpDir}/tasks.md`, `# Tasks\n${stories}`);

    // Create config with limit of 5 stories
    const config: NgentConfig = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        maxStoriesPerFeature: 5,
      },
    };

    // Should NOT throw because 5 === 5
    const prd = await analyzeFeature(tmpDir, "test", "feat/test", config);
    expect(prd.userStories).toHaveLength(5);

    await Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe" }).exited;
  });
});
