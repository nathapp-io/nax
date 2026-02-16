import { describe, expect, test } from "bun:test";
import { analyzeFeature } from "../src/cli/analyze";

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
});
