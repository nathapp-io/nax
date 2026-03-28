import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTestWriterIsolation } from "../../../src/tdd";
import { makeTempDir } from "../../helpers/temp";

describe("verifyTestWriterIsolation", () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary git repository for testing
    testDir = makeTempDir("nax-isolation-test-");

    // Initialize git repo using Bun.spawn (test fixture setup)
    const initProc = Bun.spawn(["git", "init"], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
    await initProc.exited;
    const emailProc = Bun.spawn(["git", "config", "user.email", "test@test.com"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await emailProc.exited;
    const nameProc = Bun.spawn(["git", "config", "user.name", "Test"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await nameProc.exited;

    // Create initial commit using Bun.write and Bun.spawn
    writeFileSync(join(testDir, "README.md"), "# Test");
    const addProc = Bun.spawn(["git", "add", "."], { cwd: testDir, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;
    const commitProc = Bun.spawn(["git", "commit", "-m", "Initial commit"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await commitProc.exited;
  });

  afterEach(() => {
    // Clean up
    rmSync(testDir, { recursive: true, force: true });
  });

  async function gitAdd(cwd: string): Promise<void> {
    const addProc = Bun.spawn(["git", "add", "."], { cwd, stdout: "pipe", stderr: "pipe" });
    await addProc.exited;
  }

  test("passes when only test files are modified", async () => {
    // Create test file using Bun.write and mkdir
    const testDir2 = join(testDir, "test");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(testDir2, { recursive: true });
    writeFileSync(join(testDir2, "example.test.ts"), "test code");
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations ?? []).toHaveLength(0);
  });

  test("fails when source files are modified (hard violation)", async () => {
    // Create source file
    const srcDir = join(testDir, "src", "auth");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "service.ts"), "source code");
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("src/auth/service.ts");
  });

  test("passes with soft violation when barrel export is modified (default allowed paths)", async () => {
    // Create src/index.ts (barrel export)
    const srcDir = join(testDir, "src");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), 'export * from "./module"');
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations).toContain("src/index.ts");
  });

  test("passes with soft violation when nested barrel export is modified", async () => {
    // Create src/module/index.ts (nested barrel export)
    const moduleDir = join(testDir, "src", "module");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "index.ts"), 'export * from "./service"');
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations).toContain("src/module/index.ts");
  });

  test("respects custom allowed paths", async () => {
    // Create custom allowed file
    const configDir = join(testDir, "src", "config");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.ts"), "config");
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD", ["src/config/config.ts"]);
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.softViolations).toContain("src/config/config.ts");
  });

  test("combines hard and soft violations correctly", async () => {
    // Create both barrel export (soft) and source file (hard)
    const authDir = join(testDir, "src", "auth");
    const srcDir = join(testDir, "src");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(authDir, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), 'export * from "./module"');
    writeFileSync(join(authDir, "service.ts"), "source code");
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD");
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("src/auth/service.ts");
    expect(result.softViolations).toContain("src/index.ts");
  });

  test("empty allowed paths array means no soft violations", async () => {
    // Create src/index.ts
    const srcDir = join(testDir, "src");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "index.ts"), 'export * from "./module"');
    await gitAdd(testDir);

    const result = await verifyTestWriterIsolation(testDir, "HEAD", []);
    expect(result.passed).toBe(false);
    expect(result.violations).toContain("src/index.ts");
    expect(result.softViolations ?? []).toHaveLength(0);
  });
});
