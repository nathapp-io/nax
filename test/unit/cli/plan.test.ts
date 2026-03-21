/**
 * Unit tests for planCommand (PLN-001)
 *
 * Tests new behavior: prd.json output, --auto mode, --from spec path,
 * project auto-detection, branchName defaults, JSON validation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _deps, buildPlanningPrompt, planCommand } from "../../../src/cli/plan";
import type { PRD } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature: URL Shortener
## Problem
Need a way to shorten URLs.
## Acceptance Criteria
- AC-1: Shorten URL
- AC-2: Redirect to original
`;

const SAMPLE_PRD: PRD = {
  project: "auto-detected",
  feature: "url-shortener",
  branchName: "feat/url-shortener",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Shorten URL",
      description: "User can shorten a long URL",
      acceptanceCriteria: ["AC-1: Returns shortened URL"],
      tags: ["feature"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Single function, clear output",
      },
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Capture originals before any test overrides */
const origReadFile = _deps.readFile;
const origWriteFile = _deps.writeFile;
const origScanCodebase = _deps.scanCodebase;
const origGetAgent = _deps.getAgent;
const origReadPackageJson = _deps.readPackageJson;
const origSpawnSync = _deps.spawnSync;
const origMkdirp = _deps.mkdirp;
const origExistsSync = _deps.existsSync;

function makeFakeAdapter(returnPrd: object = SAMPLE_PRD) {
  return {
    complete: mock(async (_prompt: string) => JSON.stringify(returnPrd)),
  };
}

function makeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: { express: "^4.18.0" },
    devDependencies: { vitest: "^1.0.0" },
    testPatterns: ["Test framework: vitest"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;
  let capturedCompleteArgs: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-plan-test-"));
    capturedWriteArgs = [];
    capturedCompleteArgs = [];

    // Create nax directory
    Bun.spawnSync(["mkdir", "-p", join(tmpDir, ".nax")]);

    // Default deps — override per test as needed
    _deps.readFile = mock(async (_path: string) => SAMPLE_SPEC);

    _deps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });

    _deps.scanCodebase = mock(async (_workdir: string) => makeFakeScan());

    _deps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-project" }));

    _deps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from(""),
      exitCode: 1,
    }));

    _deps.mkdirp = mock(async (_path: string) => {});

    _deps.getAgent = mock((_name: string) => {
      const adapter = makeFakeAdapter();
      capturedCompleteArgs = [];
      adapter.complete = mock(async (prompt: string) => {
        capturedCompleteArgs.push(prompt);
        return JSON.stringify(SAMPLE_PRD);
      });
      return adapter as ReturnType<typeof makeFakeAdapter> as never;
    });
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
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-1: reads spec from --from path and includes content in prompt
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: reads spec from --from path and includes content in planning prompt", async () => {
    const specPath = join(tmpDir, "spec.md");
    _deps.readFile = mock(async (path: string) => {
      if (path === specPath) return SAMPLE_SPEC;
      throw new Error(`Unexpected readFile call: ${path}`);
    });

    await planCommand(tmpDir, {} as never, {
      from: specPath,
      feature: "url-shortener",
      auto: true,
    });

    expect(_deps.readFile).toHaveBeenCalledWith(specPath);
    expect(capturedCompleteArgs[0]).toContain("URL Shortener");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: planning prompt includes codebase context, output schema, complexity
  //       guide, and test strategy guide
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: prompt includes codebase context", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("Codebase");
    expect(prompt).toContain("express");
  });

  test("AC-2: prompt includes output schema with prd.json structure", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("userStories");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("dependencies");
  });

  test("AC-2: prompt includes complexity classification guide", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("simple");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("complex");
    expect(prompt).toContain("expert");
  });

  test("AC-2: prompt includes test strategy guide", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("test-after");
    expect(prompt).toContain("tdd-lite");
    expect(prompt).toContain("three-session-tdd");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: adapter.complete() is called with the full planning prompt
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: adapter.complete() is called in --auto mode", async () => {
    const fakeAdapter = makeFakeAdapter();
    _deps.getAgent = mock((_name: string) => fakeAdapter as never);

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    expect(fakeAdapter.complete).toHaveBeenCalledTimes(1);
  });

  test("AC-3: interactive mode is now supported when --auto not set", async () => {
    const fakeAdapter = {
      plan: mock(async (_options: any) => ({ specContent: "" })),
      complete: mock(async (_prompt: string) => JSON.stringify(SAMPLE_PRD)),
    };
    _deps.getAgent = mock((_name: string) => fakeAdapter as never);
    // Simulate agent having written the PRD file to disk
    _deps.existsSync = mock((_path: string) => true);
    _deps.readFile = mock(async (_path: string) => JSON.stringify(SAMPLE_PRD));

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(fakeAdapter.plan).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: JSON response validated — invalid JSON or missing fields throws
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: throws on invalid JSON response from adapter", async () => {
    _deps.getAgent = mock(
      (_name: string) =>
        ({
          complete: mock(async () => "not valid json {{"),
        }) as never,
    );

    await expect(
      planCommand(tmpDir, {} as never, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      }),
    ).rejects.toThrow(/parse JSON|Failed to parse/);
  });

  test("AC-4: missing project field is auto-filled with feature name", async () => {
    // validatePlanOutput auto-fills project from feature when absent (per spec)
    const prdWithoutProject = { ...SAMPLE_PRD } as Partial<PRD>;
    delete prdWithoutProject.project;

    _deps.getAgent = mock(
      (_name: string) =>
        ({
          complete: mock(async () => JSON.stringify(prdWithoutProject)),
        }) as never,
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });
    // Verify written PRD has project auto-filled (from package.json mock → "my-project")
    expect(capturedWriteArgs.length).toBeGreaterThan(0);
    const written = JSON.parse(capturedWriteArgs[0]![1]);
    expect(written.project).toBeDefined();
    expect(typeof written.project).toBe("string");
  });

  test("AC-4: throws when required field 'userStories' is missing", async () => {
    const badPrd = { ...SAMPLE_PRD } as Partial<PRD>;
    delete badPrd.userStories;

    _deps.getAgent = mock(
      (_name: string) =>
        ({
          complete: mock(async () => JSON.stringify(badPrd)),
        }) as never,
    );

    expect(
      planCommand(tmpDir, {} as never, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      }),
    ).rejects.toThrow("userStories");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: output written to nax/features/<feature>/prd.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-5: output path is nax/features/<feature>/prd.json", async () => {
    const result = await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const expectedPath = join(tmpDir, ".nax", "features", "url-shortener", "prd.json");
    expect(result).toBe(expectedPath);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);
  });

  test("AC-5: written content is valid JSON with PRD structure", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.userStories).toBeDefined();
    expect(Array.isArray(written.userStories)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-6: all story statuses forced to 'pending'
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-6: forces all story statuses to pending regardless of LLM output", async () => {
    const prdWithBadStatuses: PRD = {
      ...SAMPLE_PRD,
      userStories: [
        { ...SAMPLE_PRD.userStories[0], status: "passed" },
        { ...SAMPLE_PRD.userStories[0], id: "US-002", status: "failed" },
      ],
    };

    _deps.getAgent = mock(
      (_name: string) =>
        ({
          complete: mock(async () => JSON.stringify(prdWithBadStatuses)),
        }) as never,
    );

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    for (const story of written.userStories) {
      expect(story.status).toBe("pending");
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-7: project auto-detected from package.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-7: project field comes from package.json name", async () => {
    _deps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-awesome-pkg" }));

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.project).toBe("my-awesome-pkg");
  });

  test("AC-7: falls back to git remote when package.json has no name", async () => {
    _deps.readPackageJson = mock(async (_workdir: string) => ({}));
    _deps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from("https://github.com/org/repo-name.git\n"),
      exitCode: 0,
    }));

    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.project).toBe("repo-name");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-8: branchName defaults to feat/<feature>, overridable via -b
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-8: branchName defaults to feat/<feature>", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "my-feat",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.branchName).toBe("feat/my-feat");
  });

  test("AC-8: branchName can be overridden via branch option", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "my-feat",
      auto: true,
      branch: "custom/branch-name",
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.branchName).toBe("custom/branch-name");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Guard: throws when nax not initialized
  // ──────────────────────────────────────────────────────────────────────────

  test("throws when nax directory not found", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "nax-plan-empty-"));
    Bun.spawnSync(["rm", "-rf", join(emptyDir, ".nax")]);

    expect(
      planCommand(emptyDir, {} as never, {
        from: "/spec.md",
        feature: "test",
        auto: true,
      }),
    ).rejects.toThrow("nax directory not found");

    Bun.spawnSync(["rm", "-rf", emptyDir]);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // timestamps
  // ──────────────────────────────────────────────────────────────────────────

  test("output PRD has createdAt and updatedAt ISO timestamps", async () => {
    await planCommand(tmpDir, {} as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ENH-006: buildPlanningPrompt — 3-step structure + analysis + contextFiles
// ──────────────────────────────────────────────────────────────────────────

describe("buildPlanningPrompt (ENH-006)", () => {
  const spec = "Refactor auth module to use @nathapp/nestjs-auth";
  const ctx = "## Codebase Structure\nsrc/auth/auth.module.ts";

  test("prompt has Step 1 — understand the spec", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("Understand the Spec");
  });

  test("prompt has Step 2 — analyze", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain("Step 2");
    expect(prompt).toContain("Analyze");
  });

  test("prompt has Step 3 — generate stories", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain("Step 3");
    expect(prompt).toContain("Generate Implementation Stories");
  });

  test("prompt handles greenfield guidance", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain("greenfield project");
  });

  test("output schema includes analysis field", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain('"analysis"');
  });

  test("output schema includes contextFiles field", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain('"contextFiles"');
  });

  test("testStrategy list is in correct order (tdd-simple first, test-after last)", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).toContain('tdd-simple | three-session-tdd-lite | three-session-tdd | test-after');
  });

  test("monorepo: includes workdir field in schema", () => {
    const prompt = buildPlanningPrompt(spec, ctx, undefined, ["apps/api", "apps/web"]);
    expect(prompt).toContain('"workdir"');
  });

  test("non-monorepo: no workdir field in schema", () => {
    const prompt = buildPlanningPrompt(spec, ctx);
    expect(prompt).not.toContain('"workdir"');
  });
});
