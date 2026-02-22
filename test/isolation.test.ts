import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { isTestFile, isSourceFile, verifyTestWriterIsolation } from "../src/tdd";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

describe("isTestFile", () => {
  test("matches test/ directory", () => {
    expect(isTestFile("test/auth.e2e-spec.ts")).toBe(true);
  });

  test("matches .spec.ts files", () => {
    expect(isTestFile("src/auth/auth.spec.ts")).toBe(true);
  });

  test("matches .test.ts files", () => {
    expect(isTestFile("src/utils.test.ts")).toBe(true);
  });

  test("does not match source files", () => {
    expect(isTestFile("src/auth/auth.service.ts")).toBe(false);
  });
});

describe("isSourceFile", () => {
  test("matches src/ directory", () => {
    expect(isSourceFile("src/auth/auth.service.ts")).toBe(true);
  });

  test("matches lib/ directory", () => {
    expect(isSourceFile("lib/utils.ts")).toBe(true);
  });

  test("does not match test files in test/", () => {
    expect(isSourceFile("test/auth.spec.ts")).toBe(false);
  });
});

describe("verifyTestWriterIsolation", () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary git repository for testing
    testDir = mkdtempSync(join(tmpdir(), "nax-isolation-test-"));
    execSync("git init", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.name 'Test'", { cwd: testDir, stdio: "ignore" });
    // Create initial commit
    execSync("touch README.md", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });
    execSync("git commit -m 'Initial commit'", { cwd: testDir, stdio: "ignore" });
  });

  afterEach(() => {
    // Clean up
    rmSync(testDir, { recursive: true, force: true });
  });

  test("passes when only test files are modified", async () => {
    // Create test file
    execSync("mkdir -p test", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'test code' > test/example.test.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations ?? []).toHaveLength(0);
  });

  test("fails when source files are modified (hard violation)", async () => {
    // Create source file
    execSync("mkdir -p src/auth", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'source code' > src/auth/service.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("src/auth/service.ts");
  });

  test("passes with soft violation when barrel export is modified (default allowed paths)", async () => {
    // Create src/index.ts (barrel export)
    execSync("mkdir -p src", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'export * from \"./module\"' > src/index.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations).toContain("src/index.ts");
  });

  test("passes with soft violation when nested barrel export is modified", async () => {
    // Create src/module/index.ts (nested barrel export)
    execSync("mkdir -p src/module", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'export * from \"./service\"' > src/module/index.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations).toContain("src/module/index.ts");
  });

  test("respects custom allowed paths", async () => {
    // Create custom allowed file
    execSync("mkdir -p src/config", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'config' > src/config/config.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD", ["src/config/config.ts"]);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations).toContain("src/config/config.ts");
  });

  test("combines hard and soft violations correctly", async () => {
    // Create both barrel export (soft) and source file (hard)
    execSync("mkdir -p src/auth", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'export * from \"./module\"' > src/index.ts", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'source code' > src/auth/service.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("src/auth/service.ts");
    expect(result.softViolations).toContain("src/index.ts");
  });

  test("empty allowed paths array means no soft violations", async () => {
    // Create src/index.ts
    execSync("mkdir -p src", { cwd: testDir, stdio: "ignore" });
    execSync("echo 'export * from \"./module\"' > src/index.ts", { cwd: testDir, stdio: "ignore" });
    execSync("git add .", { cwd: testDir, stdio: "ignore" });

    const result = await verifyTestWriterIsolation(testDir, "HEAD", []);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("src/index.ts");
    expect(result.softViolations ?? []).toHaveLength(0);
  });
});
