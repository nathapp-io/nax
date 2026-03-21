/**
 * Unit tests for planCommand — MW-007 monorepo awareness
 *
 * Verifies that when packages are discovered, the planning prompt includes:
 * - A monorepo hint section listing detected packages
 * - A "workdir" field in the output schema
 *
 * And that when no packages are found (single-repo), neither appears.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _deps, planCommand } from "../../../src/cli/plan";
import type { PRD } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_PRD: PRD = {
  project: "my-project",
  feature: "test-feature",
  branchName: "feat/test-feature",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Test story",
      description: "A test story",
      acceptanceCriteria: ["AC-1: It works"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Simple task",
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _deps.readFile;
const origWriteFile = _deps.writeFile;
const origScanCodebase = _deps.scanCodebase;
const origGetAgent = _deps.getAgent;
const origReadPackageJson = _deps.readPackageJson;
const origSpawnSync = _deps.spawnSync;
const origMkdirp = _deps.mkdirp;
const origExistsSync = _deps.existsSync;
const origDiscoverWorkspacePackages = _deps.discoverWorkspacePackages;
const origReadPackageJsonAt = _deps.readPackageJsonAt;
const origCreateInteractionBridge = _deps.createInteractionBridge;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — MW-007 monorepo awareness", () => {
  let tmpDir: string;
  let capturedPrompts: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-plan-mono-test-"));
    capturedPrompts = [];

    Bun.spawnSync(["mkdir", "-p", join(tmpDir, ".nax")]);

    _deps.readFile = mock(async () => "# Spec\nDo something.");
    _deps.writeFile = mock(async () => {});
    _deps.scanCodebase = mock(async () => ({
      fileTree: "└── src/",
      dependencies: {},
      devDependencies: {},
      testPatterns: [],
    }));
    _deps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _deps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _deps.mkdirp = mock(async () => {});
    _deps.getAgent = mock((_name: string) => ({
      complete: mock(async (prompt: string) => {
        capturedPrompts.push(prompt);
        return JSON.stringify(SAMPLE_PRD);
      }),
    })) as never;
  });

  afterEach(() => {
    mock.restore();
    _deps.readFile = origReadFile;
    _deps.writeFile = origWriteFile;
    _deps.scanCodebase = origScanCodebase;
    _deps.getAgent = origGetAgent;
    _deps.readPackageJson = origReadPackageJson;
    _deps.readPackageJsonAt = origReadPackageJsonAt;
    _deps.spawnSync = origSpawnSync;
    _deps.mkdirp = origMkdirp;
    _deps.existsSync = origExistsSync;
    _deps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  });

  test("injects monorepo hint when packages are discovered", async () => {
    _deps.discoverWorkspacePackages = mock(async () => [
      `${tmpDir}/packages/api`,
      `${tmpDir}/packages/web`,
    ]);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain("Monorepo Context");
    expect(prompt).toContain("packages/api");
    expect(prompt).toContain("packages/web");
  });

  test("includes workdir field in schema when monorepo detected", async () => {
    _deps.discoverWorkspacePackages = mock(async () => [`${tmpDir}/packages/api`]);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain('"workdir"');
  });

  test("monorepo hint includes instruction to set workdir per story", async () => {
    _deps.discoverWorkspacePackages = mock(async () => [`${tmpDir}/packages/api`]);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain("workdir");
    expect(prompt).toContain("monorepo");
  });

  test("no monorepo hint when no packages discovered", async () => {
    _deps.discoverWorkspacePackages = mock(async () => []);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).not.toContain("Monorepo Context");
  });

  test("no workdir field in schema when no packages discovered", async () => {
    _deps.discoverWorkspacePackages = mock(async () => []);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    // workdir should not appear in the schema when not a monorepo
    expect(prompt).not.toContain('"workdir"');
  });

  test("package paths in prompt are relative to repo root", async () => {
    _deps.discoverWorkspacePackages = mock(async () => [
      `${tmpDir}/packages/api`,
      `${tmpDir}/apps/web`,
    ]);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    // Should NOT contain the full absolute path
    expect(prompt).not.toContain(tmpDir);
    // Should contain relative paths
    expect(prompt).toContain("packages/api");
    expect(prompt).toContain("apps/web");
  });
});

describe("planCommand — per-package tech stack in prompt", () => {
  let tmpDir: string;
  let capturedPrompts: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-plan-pkgstack-test-"));
    capturedPrompts = [];
    Bun.spawnSync(["mkdir", "-p", join(tmpDir, ".nax")]);

    _deps.readFile = mock(async () => "# Spec\nDo something.\n");
    _deps.existsSync = mock(() => true);
    _deps.writeFile = mock(async () => {});
    _deps.scanCodebase = mock(async () => ({ fileTree: "└── src/", dependencies: {}, devDependencies: {}, testPatterns: [] }));
    _deps.readPackageJson = mock(async () => ({ name: "monorepo-root" }));
    _deps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _deps.mkdirp = mock(async () => {});
    _deps.createInteractionBridge = mock(() => ({ detectQuestion: mock(async () => false), onQuestionDetected: mock(async () => "") }));
    const minimalPrd = { project: "test", feature: "test", branchName: "feat/test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), userStories: [{ id: "US-001", title: "Test", description: "Test story", acceptanceCriteria: ["AC-1"], tags: [], dependencies: [], status: "pending", passes: false, escalations: [], attempts: 0, routing: { complexity: "simple", testStrategy: "test-after", reasoning: "simple" } }] };
    _deps.getAgent = mock(() => ({ complete: mock(async (p: string) => { capturedPrompts.push(p); return JSON.stringify(minimalPrd); }) } as never));
  });

  afterEach(() => {
    mock.restore();
    _deps.readFile = origReadFile;
    _deps.writeFile = origWriteFile;
    _deps.scanCodebase = origScanCodebase;
    _deps.getAgent = origGetAgent;
    _deps.readPackageJson = origReadPackageJson;
    _deps.spawnSync = origSpawnSync;
    _deps.mkdirp = origMkdirp;
    _deps.existsSync = origExistsSync;
    _deps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _deps.readPackageJsonAt = origReadPackageJsonAt;
    _deps.createInteractionBridge = origCreateInteractionBridge;
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  });

  test("includes Package Tech Stacks table when packages have package.json", async () => {
    _deps.discoverWorkspacePackages = mock(async () => ["packages/api", "packages/web"]);
    _deps.readPackageJsonAt = mock(async (path: string) => {
      if (path.includes("packages/api")) return { name: "@myapp/api", dependencies: { express: "^4.18", prisma: "^5.0" }, devDependencies: { jest: "^29" } };
      if (path.includes("packages/web")) return { name: "@myapp/web", dependencies: { next: "^14", react: "^18", zod: "^3" }, devDependencies: { vitest: "^1" } };
      return null;
    });

    await planCommand(tmpDir, {} as never, { from: "/spec.md", feature: "test", auto: true });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain("Package Tech Stacks");
    expect(prompt).toContain("Express");
    expect(prompt).toContain("prisma");
    expect(prompt).toContain("Next.js");
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("zod");
  });

  test("omits Package Tech Stacks section for single-package repos", async () => {
    _deps.discoverWorkspacePackages = mock(async () => []);

    await planCommand(tmpDir, {} as never, { from: "/spec.md", feature: "test", auto: true });

    const prompt = capturedPrompts[0];
    expect(prompt).not.toContain("Package Tech Stacks");
  });
});
