/**
 * Unit tests for planCommand (PLN-001)
 *
 * Tests new behavior: prd.json output, --auto mode, --from spec path,
 * project auto-detection, branchName defaults, JSON validation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, buildPlanComposition, planCommand, runPlanPipeline } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import { NaxError } from "@/errors";
import type { PRD } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";
import { makeMockAgentManager, makeMockRuntime, makePRD, makeStory, makeTempDir } from "@test/helpers";

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
const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanSourceRoots = _planDeps.scanSourceRoots;
const origCreateRuntime = _planDeps.createRuntime;
const origReadPackageJson = _planDeps.readPackageJson;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;

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
  let capturedPlanArgs: string[];

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-test-");
    capturedWriteArgs = [];
    capturedPlanArgs = [];

    // Create nax directory
    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    // Default deps — ACP path: plan() writes PRD to outputPath, then readFile reads it back
    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD);
      return SAMPLE_SPEC;
    });

    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });

    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax") || path.endsWith("prd.json"));

    _planDeps.scanSourceRoots = mock(async (_workdir: string) => []);

    _planDeps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-project" }));

    _planDeps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from(""),
      exitCode: 1,
    }));

    _planDeps.mkdirp = mock(async (_path: string) => {});

    _planDeps.createRuntime = mock((_cfg: any) => {
      capturedPlanArgs = [];
      return makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async (req) => {
            const prompt = req.runOptions.prompt;
            if (prompt) capturedPlanArgs.push(prompt);
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify(SAMPLE_PRD),
                rateLimited: false,
                durationMs: 1,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          },
        }),
      });
    });
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-1: reads spec from --from path and includes content in prompt
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: reads spec from --from path and includes content in planning prompt", async () => {
    const specPath = join(tmpDir, "spec.md");
    _planDeps.readFile = mock(async (path: string) => {
      if (path === specPath) return SAMPLE_SPEC;
      throw new Error(`Unexpected readFile call: ${path}`);
    });

    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: specPath,
      feature: "url-shortener",
      auto: true,
    });

    expect(_planDeps.readFile).toHaveBeenCalledWith(specPath);
    expect(capturedPlanArgs[0]).toContain("URL Shortener");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: planning prompt includes codebase context, output schema, complexity
  //       guide, and test strategy guide
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: prompt includes codebase context, output schema, complexity guide, and test strategy guide", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedPlanArgs[0];
    expect(prompt).toContain("Source Roots");
    expect(prompt).toContain("Read, Grep, and Glob tools");
    expect(prompt).toContain("userStories");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("dependencies");
    expect(prompt).toContain("simple");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("complex");
    expect(prompt).toContain("expert");
    expect(prompt).toContain("test-after");
    expect(prompt).toContain("tdd-lite");
    expect(prompt).toContain("three-session-tdd");
  });

  test("uses explicit plan model selector to choose adapter", async () => {
    let receivedAgentName: string | undefined;

    _planDeps.createRuntime = mock((cfg: any) =>
      makeMockRuntime({
        config: cfg,
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async (_req, primaryAgentOverride) => {
            receivedAgentName = primaryAgentOverride;
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify(SAMPLE_PRD),
                rateLimited: false,
                durationMs: 1,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          },
        }),
      }),
    );

    const config = {
      ...DEFAULT_CONFIG,
      models: {
        ...DEFAULT_CONFIG.models,
        codex: {
          fast: { provider: "openai", model: "gpt-5.4-mini" },
          balanced: { provider: "openai", model: "gpt-5.4" },
          powerful: { provider: "openai", model: "gpt-5.5" },
        },
      },
      plan: {
        ...DEFAULT_CONFIG.plan,
        model: { agent: "codex", model: "gpt-5.3-codex" },
      },
    } as const;

    await planCommand(tmpDir, config as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    expect(receivedAgentName).toBe("codex");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: interactive mode (non-auto path uses runAs)
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: interactive mode is now supported when --auto not set", async () => {
    const planSpy = mock(async (_req: any) => {});
    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async (req) => {
            await planSpy(req);
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify(SAMPLE_PRD),
                rateLimited: false,
                durationMs: 1,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          },
        }),
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(planSpy).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: JSON response validated — invalid JSON or missing fields throws
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: throws on invalid JSON response from adapter", async () => {
    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: "not valid json {{",
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          }),
        }),
      }),
    );
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));

    await expect(
      planCommand(tmpDir, DEFAULT_CONFIG as never, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      }),
    ).rejects.toThrow(/parse JSON|Failed to parse/);
  });

  test("AC-4: missing project field is auto-filled with feature name", async () => {
    // validatePlanOutput auto-fills project from feature when absent (per spec)
    const prdWithoutProject = { ...SAMPLE_PRD } as Partial<PRD>;
    prdWithoutProject.project = undefined;

    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: JSON.stringify(prdWithoutProject),
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          }),
        }),
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });
    // capturedWriteArgs[0] = validated PRD (planOp.parse now calls validatePlanOutput internally)
    expect(capturedWriteArgs.length).toBeGreaterThan(0);
    const written = JSON.parse(capturedWriteArgs[0]?.[1]);
    expect(written.project).toBeDefined();
    expect(typeof written.project).toBe("string");
  });

  test("AC-4: throws when required field 'userStories' is missing", async () => {
    const badPrd = { ...SAMPLE_PRD } as Partial<PRD>;
    badPrd.userStories = undefined;

    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: JSON.stringify(badPrd),
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          }),
        }),
      }),
    );
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));

    await expect(
      planCommand(tmpDir, DEFAULT_CONFIG as never, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      }),
    ).rejects.toThrow("userStories");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: output written to nax/features/<feature>/prd.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-5: output path is nax/features/<feature>/prd.json and content is valid JSON with PRD structure", async () => {
    const result = await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const expectedPath = join(tmpDir, ".nax", "features", "url-shortener", "prd.json");
    expect(result).toBe(expectedPath);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);
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

    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: JSON.stringify(prdWithBadStatuses),
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          }),
        }),
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
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
    _planDeps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-awesome-pkg" }));

    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.project).toBe("my-awesome-pkg");
  });

  test("AC-7: falls back to git remote when package.json has no name", async () => {
    _planDeps.readPackageJson = mock(async (_workdir: string) => ({}));
    _planDeps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from("https://github.com/org/repo-name.git\n"),
      exitCode: 0,
    }));

    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
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

  test.each([
    ["defaults to feat/<feature>", undefined, "feat/my-feat"],
    ["can be overridden via branch option", "custom/branch-name", "custom/branch-name"],
  ] as const)("AC-8: branchName %s", async (_label, branch, expected) => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "my-feat",
      auto: true,
      ...(branch ? { branch } : {}),
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.branchName).toBe(expected);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Guard: throws when nax not initialized
  // ──────────────────────────────────────────────────────────────────────────

  test("throws when nax directory not found", async () => {
    const emptyDir = makeTempDir("nax-plan-empty-");
    await rm(join(emptyDir, ".nax"), { recursive: true, force: true });
    _planDeps.existsSync = origExistsSync; // use real FS — .nax doesn't exist here

    expect(
      planCommand(emptyDir, {} as never, {
        from: "/spec.md",
        feature: "test",
        auto: true,
      }),
    ).rejects.toThrow("nax directory not found");

    await rm(emptyDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // timestamps
  // ──────────────────────────────────────────────────────────────────────────

  test("output PRD has createdAt and updatedAt ISO timestamps", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-12: scanSourceRoots is invoked and rendered section is passed to builder
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-12: runPlanCommand invokes _planDeps.scanSourceRoots(workdir)", async () => {
    let scanSourceRootsWasCalled = false;
    let scanSourceRootsArg: string | undefined;

    const origScanSourceRoots = _planDeps.scanSourceRoots;
    _planDeps.scanSourceRoots = mock(async (workdir: string) => {
      scanSourceRootsWasCalled = true;
      scanSourceRootsArg = workdir;
      return [];
    });

    try {
      await planCommand(tmpDir, DEFAULT_CONFIG as never, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      });

      expect(scanSourceRootsWasCalled).toBe(true);
      expect(scanSourceRootsArg).toBe(tmpDir);
    } finally {
      if (origScanSourceRoots) _planDeps.scanSourceRoots = origScanSourceRoots;
    }
  });

  test("AC-12: renders source roots section and passes as codebaseContext to PlanPromptBuilder", async () => {
    let capturedCodebaseContext: string | undefined;

    const origCreateRuntime = _planDeps.createRuntime;
    _planDeps.createRuntime = mock((cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async (req) => {
            const prompt = req.runOptions.prompt;
            // The codebaseContext is passed to PlanPromptBuilder.build() and becomes part of taskContext
            if (prompt) {
              capturedCodebaseContext = prompt;
            }
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify(SAMPLE_PRD),
                rateLimited: false,
                durationMs: 1,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          },
        }),
      }),
    );

    _planDeps.scanSourceRoots = mock(async (_workdir: string) => [
      { path: "packages/api", language: "typescript", framework: "NestJS", testRunner: "jest" },
    ]);

    try {
      await planCommand(tmpDir, DEFAULT_CONFIG as never, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      });

      expect(capturedCodebaseContext).toContain("## Source Roots");
      expect(capturedCodebaseContext).toContain("packages/api");
    } finally {
      if (origCreateRuntime) _planDeps.createRuntime = origCreateRuntime;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ENH-006: buildPlanningPrompt — 3-step structure + analysis + contextFiles
// ──────────────────────────────────────────────────────────────────────────

describe("buildPlanningPrompt (ENH-006)", () => {
  const spec = "Refactor auth module to use @nathapp/nestjs-auth";
  const ctx = "## Codebase Structure\nsrc/auth/auth.module.ts";

  /** Helper: concatenate both parts into a single string for content assertions. */
  function fullPrompt(...args: Parameters<InstanceType<typeof PlanPromptBuilder>["build"]>): string {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(...args);
    return `${taskContext}\n\n${outputFormat}`;
  }

  test.each([
    ["Step 1", "Understand the Spec"],
    ["Step 2", "Analyze"],
    ["Step 3", "Generate Implementation Stories"],
  ])("prompt has %s", (step, text) => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain(step);
    expect(prompt).toContain(text);
  });

  test("prompt handles greenfield guidance", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("greenfield project");
  });

  test.each(['"analysis"', '"contextFiles"'])("output schema includes %s field", (field) => {
    expect(fullPrompt(spec, ctx)).toContain(field);
  });

  test("testStrategy list is in correct order (tdd-simple first, test-after last)", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("tdd-simple | three-session-tdd-lite | three-session-tdd | test-after");
  });

  test("workdir field in schema iff monorepo packages provided", () => {
    expect(fullPrompt(spec, ctx, undefined, ["apps/api", "apps/web"])).toContain('"workdir"');
    expect(fullPrompt(spec, ctx)).not.toContain('"workdir"');
  });

  test("taskContext excludes output schema — no Output Schema header or JSON field listing", () => {
    const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).not.toContain("Output Schema");
    expect(taskContext).not.toContain('"analysis": "string');
  });

  test("outputFormat contains schema and format directive but not spec steps", () => {
    const { outputFormat } = new PlanPromptBuilder().build(spec, ctx);
    expect(outputFormat).toContain("Output Schema");
    expect(outputFormat).toContain('"analysis"');
    expect(outputFormat).not.toContain("Step 1");
  });
});

// ─── fix #346: spec anchor rules (non-debate plan mode) ──────────────────────

describe("buildPlanningPrompt — spec anchor (fix #346)", () => {
  const spec = "## Acceptance Criteria\n- AC-1: Returns 200 when project exists";
  const ctx = "## Codebase Structure\nsrc/projects/projects.service.ts";

  test("spec anchor rules included in taskContext iff specContent is non-empty", () => {
    const { taskContext: withSpec } = new PlanPromptBuilder().build(spec, ctx);
    const { taskContext: withoutSpec } = new PlanPromptBuilder().build("", ctx);
    expect(withSpec).toContain("Preserve spec ACs");
    expect(withoutSpec).not.toContain("Preserve spec ACs");
  });

  test.each([
    ["suggestedCriteria"],
    ["Never silently drop"],
    ["story scope"],
  ])("taskContext with spec contains '%s'", (text) => {
    const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).toContain(text);
  });

  test("outputFormat schema includes suggestedCriteria iff spec is non-empty", () => {
    const { outputFormat: withSpec } = new PlanPromptBuilder().build(spec, ctx);
    const { outputFormat: withoutSpec } = new PlanPromptBuilder().build("", ctx);
    expect(withSpec).toContain("suggestedCriteria");
    expect(withoutSpec).not.toContain("suggestedCriteria");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertIsValidPrd guard — issue #993 regression tests
// ─────────────────────────────────────────────────────────────────────────────

describe("assertIsValidPrd guard (#993)", () => {
  let tmpDir993: string;
  let capturedWrites993: Array<[string, string]>;

  const origCreateRuntime993 = _planDeps.createRuntime;
  const origExistsSync993 = _planDeps.existsSync;
  const origReadFile993 = _planDeps.readFile;
  const origWriteFile993 = _planDeps.writeFile;

  beforeEach(async () => {
    tmpDir993 = makeTempDir("nax-plan-993-");
    capturedWrites993 = [];
    await mkdir(join(tmpDir993, ".nax"), { recursive: true });

    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWrites993.push([path, content]);
    });
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.createRuntime = origCreateRuntime993;
    _planDeps.existsSync = origExistsSync993;
    _planDeps.readFile = origReadFile993;
    _planDeps.writeFile = origWriteFile993;
    await rm(tmpDir993, { recursive: true, force: true });
  });

  function makeHopInvokingRuntime() {
    return makeMockRuntime({
      agentManager: makeMockAgentManager({
        runAsSessionFn: async () => ({
          output: "File already valid. No changes needed.",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        }),
        runWithFallbackFn: async (req: any) => {
          const result = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
          return {
            result: {
              success: true,
              exitCode: 0,
              rateLimited: false,
              durationMs: 1,
              output: result.result.output,
              estimatedCostUsd: result.result.estimatedCostUsd ?? 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          };
        },
      }),
    });
  }

  test("chat-ack on all retry attempts with no prd.json on disk throws PLAN_ENVELOPE_LEAK", async () => {
    // op.recover reads Bun.file(outputPath) — file not on real disk → returns null.
    // callOp returns lastRetryTurn (envelope). assertIsValidPrd throws PLAN_ENVELOPE_LEAK.
    // No prd.json → catch block re-throws.
    _planDeps.createRuntime = mock(() => makeHopInvokingRuntime());
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));
    _planDeps.readFile = mock(async () => SAMPLE_SPEC);

    await expect(
      planCommand(tmpDir993, DEFAULT_CONFIG as never, {
        from: "/spec.md",
        feature: "url-shortener",
      }),
    ).rejects.toThrow("envelope-shaped object");
  });

  test("chat-ack on all retry attempts triggers _planDeps disk recovery when existsSync is true", async () => {
    // op.recover reads Bun.file(outputPath) — real file absent → returns null.
    // callOp returns lastRetryTurn (TurnResult envelope).
    // assertIsValidPrd throws PLAN_ENVELOPE_LEAK.
    // planCommand catch: existsSync → true; _planDeps.readFile returns valid PRD → recovered.
    _planDeps.createRuntime = mock(() => makeHopInvokingRuntime());
    _planDeps.existsSync = mock((p: string) => p.endsWith(".nax") || p.endsWith("prd.json"));
    _planDeps.readFile = mock(async (p: string) => {
      if (p.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD);
      return SAMPLE_SPEC;
    });

    const result = await planCommand(tmpDir993, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(result).toContain("url-shortener");
    expect(result).toContain("prd.json");
    // Field-equality on stable identity fields — validatePlanOutput may transform
    // routing.reasoning, so compare id/title rather than the full object.
    expect(capturedWrites993.length).toBeGreaterThan(0);
    const written = JSON.parse(capturedWrites993[capturedWrites993.length - 1]?.[1] ?? "{}");
    const writtenIds = (written.userStories as Array<{ id: string; title: string }>).map((s) => s.id);
    const expectedIds = SAMPLE_PRD.userStories.map((s) => s.id);
    expect(writtenIds).toEqual(expectedIds);
  });

  test("success path: valid PRD from agent preserves all userStories (field-equality regression guard)", async () => {
    // Regression guard: on the normal success path, userStories must be preserved exactly.
    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: JSON.stringify(SAMPLE_PRD),
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          }),
        }),
      }),
    );
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));
    _planDeps.readFile = mock(async () => SAMPLE_SPEC);

    await planCommand(tmpDir993, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedWrites993.length).toBeGreaterThan(0);
    const written = JSON.parse(capturedWrites993[capturedWrites993.length - 1]?.[1] ?? "{}");
    // Field-equality on stable identity fields — validatePlanOutput may transform
    // routing.reasoning, so compare ids rather than the full object.
    const writtenIds = (written.userStories as Array<{ id: string }>).map((s) => s.id);
    expect(writtenIds).toEqual(SAMPLE_PRD.userStories.map((s) => s.id));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildPlanComposition (AC-1, AC-2)
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlanComposition()", () => {
  // Base without any plug-point fields so asymmetric defaults can be injected cleanly.
  const baseConfig = {
    enabled: true,
    resolver: { type: "majority-fail-closed" as const },
    mode: "panel" as const,
    rounds: 1,
    debaters: [{ agent: "claude" }, { agent: "opencode" }],
  };

  test.each([
    ["'current'", { ...baseConfig, sessionMode: "one-shot" as const, evidenceMode: "current" as const }],
    ["absent", { ...baseConfig, sessionMode: "one-shot" as const }],
  ] as const)("AC-1: returns config unchanged when evidenceMode is %s", (_label, input) => {
    const result = buildPlanComposition(input as any);
    expect(result).toBe(input);
  });

  test.each([
    ["preDebatePhase grounder", (r: ReturnType<typeof buildPlanComposition>) => r.preDebatePhase, { kind: "grounder" }],
    ["proposers constraints", (r: ReturnType<typeof buildPlanComposition>) => r.proposers, { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 }],
    ["sessionMode stateful", (r: ReturnType<typeof buildPlanComposition>) => r.sessionMode, "stateful"],
    ["verifier-pick selector", (r: ReturnType<typeof buildPlanComposition>) => r.selector, { kind: "verifier-pick", patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 } }],
    ["plan-checklist postDebateVerifier", (r: ReturnType<typeof buildPlanComposition>) => r.postDebateVerifier, { kind: "plan-checklist" }],
  ])("AC-1: injects %s when evidenceMode is 'asymmetric'", (_label, getField, expected) => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const });
    expect(getField(result)).toEqual(expected);
  });

  test.each([
    ["preDebatePhase", { preDebatePhase: { kind: "custom" as const, onFailure: "block" as const } }, (r: ReturnType<typeof buildPlanComposition>) => r.preDebatePhase, { kind: "custom", onFailure: "block" }],
    ["selector", { selector: { kind: "synthesis" as const } }, (r: ReturnType<typeof buildPlanComposition>) => r.selector, { kind: "synthesis" }],
    ["sessionMode one-shot", { sessionMode: "one-shot" as const }, (r: ReturnType<typeof buildPlanComposition>) => r.sessionMode, "one-shot"],
    ["proposers", { proposers: { citationsRequired: false } }, (r: ReturnType<typeof buildPlanComposition>) => r.proposers, { citationsRequired: false }],
  ])("AC-2: user-specified %s overrides asymmetric default", (_label, override, getField, expected) => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const, ...override } as any);
    expect(getField(result)).toEqual(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runPlanPipeline tests (US-005 AC8-15)
// ─────────────────────────────────────────────────────────────────────────────

describe("runPlanPipeline (US-005)", () => {
  let tempWorkdir: string;
  let capturedPipelineWrites: Array<[string, string]>;

  beforeEach(async () => {
    tempWorkdir = makeTempDir("nax-pipeline-test-");
    capturedPipelineWrites = [];
    await mkdir(join(tempWorkdir, ".nax"), { recursive: true });

    _planDeps.readFile = mock(async () => "# Spec\nTest spec content");
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedPipelineWrites.push([path, content]);
    });
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    try {
      await rm(tempWorkdir, { recursive: true, force: true });
    } catch {}
  });

  // planDraftOp's parse validates:
  //  1. citation rate >= DEFAULT_CITATION_THRESHOLD (0.5) — include `claims` with cited:true
  //  2. story[*].acceptanceCriteria must be a non-empty array — patch any empty ones
  function makeDraftOpOutput(prd: PRD): string {
    const prdWithValidStories = {
      ...prd,
      userStories: prd.userStories.map((s) => ({
        ...s,
        acceptanceCriteria: s.acceptanceCriteria.length > 0 ? s.acceptanceCriteria : ["AC1: test criterion"],
        complexity: (s as Record<string, unknown>).complexity ?? "simple",
      })),
    };
    return JSON.stringify({
      ...prdWithValidStories,
      claims: [{ text: "cited claim", factIds: ["F-001"], cited: true }],
    });
  }

  // groundOp's parse validates via FactsManifestSchema.
  function makeGroundOpOutput(overrides: { repoFacts?: object[] } = {}): string {
    return JSON.stringify({
      repoFacts: overrides.repoFacts ?? [],
      specClaims: [],
      gaps: [],
    });
  }

  // Create an agentManager that sequences groundOp (call 0) and planDraftOp (call 1+).
  function makePipelineAgentManager(opts: {
    draftPrd?: PRD;
    llmFindings?: unknown[];
    capturedPrompts?: string[];
    groundManifestOverride?: object;
  } = {}) {
    const draftPrd = opts.draftPrd ?? makePRD({ feature: "test-feature" });
    const llmFindings = opts.llmFindings ?? [];
    let runCallCount = 0;

    return makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const idx = runCallCount++;
        if (opts.capturedPrompts && req.runOptions?.prompt) {
          opts.capturedPrompts.push(req.runOptions.prompt);
        }
        let output: string;
        if (idx === 0) {
          output = makeGroundOpOutput(opts.groundManifestOverride ? { repoFacts: (opts.groundManifestOverride as { repoFacts: object[] }).repoFacts } : {});
        } else if (idx === 1) {
          output = makeDraftOpOutput(draftPrd);
        } else {
          // idx >= 2: planCriticLlmOp (run-kind) or revision planDraftOp calls
          output = idx === 2 ? JSON.stringify({ findings: llmFindings }) : makeDraftOpOutput(draftPrd);
        }
        return {
          result: { success: true, exitCode: 0, output, rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
          fallbacks: [],
        };
      },
    });
  }

  describe("AC8: groundOp called first", () => {
    test("calls callOp(callCtx, groundOp, ...) exactly once before any other op", async () => {
      const callLog: string[] = [];
      let runCallCount = 0;

      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async () => {
          const idx = runCallCount++;
          callLog.push(idx === 0 ? "groundOp" : "planDraftOp");
          const output =
            idx === 0 ? makeGroundOpOutput() : makeDraftOpOutput(makePRD({ feature: "test-feature" }));
          return {
            result: { success: true, exitCode: 0, output, rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
            fallbacks: [],
          };
        },
        completeAsFn: async () => ({ output: JSON.stringify({ findings: [] }), tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }),
      });
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" });

      expect(callLog[0]).toBe("groundOp");
      expect(callLog.filter((l) => l === "groundOp").length).toBe(1);
    });
  });

  describe("AC9: planDraftOp receives manifest from groundOp + citationThreshold", () => {
    test("calls callOp with manifest from groundOp result", async () => {
      const capturedPrompts: string[] = [];
      // groundOp returns a manifest with a distinctive marker in repoFacts[0].summary;
      // renderManifestSection(manifest) includes it in the planDraftOp prompt.
      const distinctiveManifest = {
        repoFacts: [{ id: "F-001", kind: "file", evidence: "src/index.ts:1", summary: "DISTINCTIVE_MANIFEST_MARKER_XY9Z" }],
        specClaims: [],
        gaps: [],
      };
      const agentManager = makePipelineAgentManager({
        groundManifestOverride: distinctiveManifest,
        capturedPrompts,
      });
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" });

      // capturedPrompts[1] is the planDraftOp prompt; must contain the manifest content
      expect(capturedPrompts[1]).toContain("DISTINCTIVE_MANIFEST_MARKER_XY9Z");
    });

    test("uses config.plan?.citationThreshold ?? 0.5 as default", async () => {
      const capturedPrompts: string[] = [];
      const agentManager = makePipelineAgentManager({ capturedPrompts });
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      // No citationThreshold in config — must default to 0.5
      await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" });

      // The planDraftOp prompt (index 1) must include "0.5" as the citation rate
      expect(capturedPrompts[1]).toContain("0.5");
    });
  });

  describe("AC10: runPlanCritic called after planDraftOp", () => {
    test("calls runPlanCritic after planDraftOp returns", async () => {
      let runCallCount = 0;
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async () => {
          const idx = runCallCount++;
          let output: string;
          if (idx === 0) output = makeGroundOpOutput();
          else if (idx === 1) output = makeDraftOpOutput(makePRD({ feature: "test-feature" }));
          else output = JSON.stringify({ findings: [] }); // planCriticLlmOp (run-kind, idx=2)
          return {
            result: { success: true, exitCode: 0, output, rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
            fallbacks: [],
          };
        },
      });
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      const result = await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" });

      // All three phases executed: groundOp → planDraftOp → planCriticLlmOp (run-kind) → prd.json written
      expect(result).toContain("prd.json");
      expect(runCallCount).toBe(3);
    });
  });

  describe("AC11: Critic passes → write prd.json to .nax/features/<feature>/prd.json", () => {
    test("writes and returns .nax/features/<feature>/prd.json when critic passes", async () => {
      const agentManager = makePipelineAgentManager();
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      const result = await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" });

      const expectedPath = join(tempWorkdir, ".nax", "features", "test-feature", "prd.json");
      expect(result).toBe(expectedPath);
      expect(capturedPipelineWrites.length).toBeGreaterThan(0);
      expect(capturedPipelineWrites[capturedPipelineWrites.length - 1][0]).toBe(expectedPath);
    });
  });

  describe("AC12: Critic fails → throw NaxError with PLAN_CRITIC_BLOCKED", () => {
    test("throws NaxError with PLAN_CRITIC_BLOCKED and specDeltasPath when critic fails", async () => {
      const blockerPrd = makePRD({
        feature: "test-feature",
        userStories: [makeStory({ contextFiles: [{ path: "absolutely-nonexistent-file-ac12.ts", factId: "F-001" }] })],
      });
      const agentManager = makePipelineAgentManager({ draftPrd: blockerPrd });
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      const err = await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" }).catch((e) => e);

      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).code).toBe("PLAN_CRITIC_BLOCKED");
      expect((err as NaxError).context?.specDeltasPath).toBeDefined();
    });
  });

  describe("AC13: groundOp throws → wrap as NaxError with PLAN_PIPELINE_GROUND_FAILED", () => {
    test("wraps groundOp failure as NaxError with PLAN_PIPELINE_GROUND_FAILED and cause", async () => {
      const originalError = new Error("the original groundOp failure");
      const agentManager = makeMockAgentManager({
        runWithFallbackFn: async () => { throw originalError; },
      });
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      const err = await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" }).catch((e) => e);

      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).code).toBe("PLAN_PIPELINE_GROUND_FAILED");
      expect((err as NaxError).context?.cause).toBe(originalError);
    });
  });

  describe("AC14: Finally block closes runtime", () => {
    test.each([
      ["on success", () => makeMockRuntime({ agentManager: makePipelineAgentManager(), workdir: tempWorkdir })],
      ["on failure", () => makeMockRuntime({ agentManager: makeMockAgentManager({ runWithFallbackFn: async () => { throw new Error("simulated groundOp failure"); } }), workdir: tempWorkdir })],
    ])("closes runtime via rt.close() in finally block %s", async (_label, makeRt) => {
      const mockRt = makeRt();
      let closeCallCount = 0;
      const realClose = mockRt.close.bind(mockRt);
      mockRt.close = async () => { closeCallCount++; await realClose(); };
      _planDeps.createRuntime = mock(() => mockRt);

      await runPlanPipeline(tempWorkdir, DEFAULT_CONFIG as never, { from: "/spec.md", feature: "test-feature" }).catch(() => {});

      expect(closeCallCount).toBe(1);
    });
  });

  describe("AC15: planCommand integration with pipeline mode", () => {
    test("planCommand with resolvePlanMode() === 'pipeline' returns path from runPlanPipeline", async () => {
      const agentManager = makePipelineAgentManager();
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      const pipelineConfig = {
        ...DEFAULT_CONFIG,
        plan: { ...DEFAULT_CONFIG.plan, mode: "pipeline" as const },
      };

      const result = await planCommand(tempWorkdir, pipelineConfig as never, {
        from: "/spec.md",
        feature: "test-feature",
      });

      expect(result).toBe(join(tempWorkdir, ".nax", "features", "test-feature", "prd.json"));
    });

    test("planCommand no longer throws PLAN_PIPELINE_NOT_IMPLEMENTED for pipeline mode", async () => {
      const agentManager = makePipelineAgentManager();
      _planDeps.createRuntime = mock(() => makeMockRuntime({ agentManager, workdir: tempWorkdir }));

      const pipelineConfig = {
        ...DEFAULT_CONFIG,
        plan: { ...DEFAULT_CONFIG.plan, mode: "pipeline" as const },
      };

      const err = await planCommand(tempWorkdir, pipelineConfig as never, {
        from: "/spec.md",
        feature: "test-feature",
      }).catch((e) => e);

      if (err instanceof NaxError) {
        expect((err as NaxError).code).not.toBe("PLAN_PIPELINE_NOT_IMPLEMENTED");
      } else {
        // Success path — planCommand returned without throwing
        expect(typeof err).toBe("string");
      }
    });
  });
});
