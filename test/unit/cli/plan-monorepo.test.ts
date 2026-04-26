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
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planCommand } from "../../../src/cli/plan";
import type { PRD } from "../../../src/prd/types";
import { makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager, makeNaxConfig } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPlanManager(
  completeFn?: (name: string, prompt: string, opts: any) => Promise<{ output: string; costUsd: number; source: "exact" | "estimated" | "fallback" }>,
) {
  return makeMockAgentManager({ completeAsFn: completeFn });
}

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

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanCodebase = _planDeps.scanCodebase;
const origCreateManager = _planDeps.createManager;
const origReadPackageJson = _planDeps.readPackageJson;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origCreateInteractionBridge = _planDeps.createInteractionBridge;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — MW-007 monorepo awareness", () => {
  let tmpDir: string;
  let capturedPrompts: string[];

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-mono-test-");
    capturedPrompts = [];

    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD);
      return "# Spec\nDo something.";
    });
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanCodebase = mock(async () => ({
      fileTree: "└── src/",
      dependencies: {},
      devDependencies: {},
      testPatterns: [],
    }));
    _planDeps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.existsSync = mock(() => true);
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(async (_name: string, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: JSON.stringify(SAMPLE_PRD), costUsd: 0, source: "exact" as const };
      }),
    );
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createManager = origCreateManager;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("injects monorepo hint when packages are discovered", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => [`${tmpDir}/packages/api`, `${tmpDir}/packages/web`]);

    await planCommand(tmpDir, makeNaxConfig(), {
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
    _planDeps.discoverWorkspacePackages = mock(async () => [`${tmpDir}/packages/api`]);

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain('"workdir"');
  });

  test("monorepo hint includes instruction to set workdir per story", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => [`${tmpDir}/packages/api`]);

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain("workdir");
    expect(prompt).toContain("monorepo");
  });

  test("no monorepo hint when no packages discovered", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => []);

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    expect(prompt).not.toContain("Monorepo Context");
  });

  test("no workdir field in schema when no packages discovered", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => []);

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    // workdir should not appear in the schema when not a monorepo
    expect(prompt).not.toContain('"workdir"');
  });

  test("package paths in prompt are relative to repo root", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => [`${tmpDir}/packages/api`, `${tmpDir}/apps/web`]);

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "test-feature",
      auto: true,
    });

    const prompt = capturedPrompts[0];
    // Package paths should appear as relative paths, not absolute
    // (The prompt also contains the absolute output file path, so we check
    //  the monorepo section specifically rather than asserting no tmpDir at all)
    expect(prompt).toContain("packages/api");
    expect(prompt).toContain("apps/web");
    // The package listing section should not include the absolute tmpDir prefix before the package paths
    expect(prompt).not.toContain(`${tmpDir}/packages/api`);
    expect(prompt).not.toContain(`${tmpDir}/apps/web`);
  });
});

describe("planCommand — per-package tech stack in prompt", () => {
  let tmpDir: string;
  let capturedPrompts: string[];

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-pkgstack-test-");
    capturedPrompts = [];
    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    _planDeps.existsSync = mock(() => true);
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanCodebase = mock(async () => ({
      fileTree: "└── src/",
      dependencies: {},
      devDependencies: {},
      testPatterns: [],
    }));
    _planDeps.readPackageJson = mock(async () => ({ name: "monorepo-root" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createInteractionBridge = mock(() => ({
      detectQuestion: mock(async () => false),
      onQuestionDetected: mock(async () => ""),
    }));
    const minimalPrd = {
      project: "test",
      feature: "test",
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [
        {
          id: "US-001",
          title: "Test",
          description: "Test story",
          acceptanceCriteria: ["AC-1"],
          tags: [],
          dependencies: [],
          status: "pending",
          passes: false,
          escalations: [],
          attempts: 0,
          routing: { complexity: "simple", testStrategy: "test-after", reasoning: "simple" },
        },
      ],
    };
    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return JSON.stringify(minimalPrd);
      return "# Spec\nDo something.\n";
    });
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(async (_name: string, prompt: string, _opts: any) => {
        capturedPrompts.push(prompt);
        return { output: JSON.stringify(minimalPrd), costUsd: 0, source: "exact" as const };
      }),
    );
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createManager = origCreateManager;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.createInteractionBridge = origCreateInteractionBridge;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("includes Package Tech Stacks table when packages have package.json", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => ["packages/api", "packages/web"]);
    _planDeps.readPackageJsonAt = mock(async (path: string) => {
      if (path.includes("packages/api"))
        return {
          name: "@myapp/api",
          dependencies: { express: "^4.18", prisma: "^5.0" },
          devDependencies: { jest: "^29" },
        };
      if (path.includes("packages/web"))
        return {
          name: "@myapp/web",
          dependencies: { next: "^14", react: "^18", zod: "^3" },
          devDependencies: { vitest: "^1" },
        };
      return null;
    });

    await planCommand(tmpDir, makeNaxConfig(), { from: "/spec.md", feature: "test", auto: true });

    const prompt = capturedPrompts[0];
    expect(prompt).toContain("Package Tech Stacks");
    expect(prompt).toContain("Express");
    expect(prompt).toContain("prisma");
    expect(prompt).toContain("Next.js");
    expect(prompt).toContain("vitest");
    expect(prompt).toContain("zod");
  });

  test("omits Package Tech Stacks section for single-package repos", async () => {
    _planDeps.discoverWorkspacePackages = mock(async () => []);

    await planCommand(tmpDir, makeNaxConfig(), { from: "/spec.md", feature: "test", auto: true });

    const prompt = capturedPrompts[0];
    expect(prompt).not.toContain("Package Tech Stacks");
  });
});
