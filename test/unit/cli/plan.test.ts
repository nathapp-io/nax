/**
 * Unit tests for planCommand (PLN-001)
 *
 * Tests new behavior: prd.json output, --auto mode, --from spec path,
 * project auto-detection, branchName defaults, JSON validation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeTempDir } from "@test/helpers";
import { _planDeps, planCommand } from "@/cli";
import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import type { PRD } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";

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

function _makeFakeScan() {
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

    _planDeps.createRuntime = mock((_cfg: NaxConfig) => {
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

    await planCommand(tmpDir, DEFAULT_CONFIG, {
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
    await planCommand(tmpDir, DEFAULT_CONFIG, {
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

    _planDeps.createRuntime = mock((cfg: NaxConfig) =>
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

    await planCommand(tmpDir, config, {
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
    const planSpy = mock(async () => {});
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            await planSpy();
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

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(planSpy).toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: JSON response validated — invalid JSON or missing fields throws
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: throws on invalid JSON or missing userStories; auto-fills missing project field", async () => {
    // Scenario 1: invalid JSON → throws parse error
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
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
      planCommand(tmpDir, DEFAULT_CONFIG, { from: "/spec.md", feature: "url-shortener", auto: true }),
    ).rejects.toThrow(/parse JSON|Failed to parse/);

    // Scenario 2: missing userStories → throws "userStories"
    const badPrd = { ...SAMPLE_PRD } as Partial<PRD>;
    badPrd.userStories = undefined;
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
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
      planCommand(tmpDir, DEFAULT_CONFIG, { from: "/spec.md", feature: "url-shortener", auto: true }),
    ).rejects.toThrow("userStories");
  });

  test("AC-4: missing project field is auto-filled with feature name", async () => {
    // validatePlanOutput auto-fills project from feature when absent (per spec)
    const prdWithoutProject = { ...SAMPLE_PRD } as Partial<PRD>;
    prdWithoutProject.project = undefined;

    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
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

    await planCommand(tmpDir, DEFAULT_CONFIG, {
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

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: output written to nax/features/<feature>/prd.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-5: output path is nax/features/<feature>/prd.json and content is valid JSON with PRD structure", async () => {
    const result = await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const expectedPath = join(tmpDir, ".nax", "features", "url-shortener", "prd.json");
    expect(result.outputPath).toBe(expectedPath);
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

    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
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

    await planCommand(tmpDir, DEFAULT_CONFIG, {
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

  test("AC-7: project from package.json name; falls back to git remote when name absent", async () => {
    _planDeps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-awesome-pkg" }));
    await planCommand(tmpDir, DEFAULT_CONFIG, { from: "/spec.md", feature: "url-shortener", auto: true });
    expect((JSON.parse(capturedWriteArgs[0][1]) as PRD).project).toBe("my-awesome-pkg");

    capturedWriteArgs = [];
    _planDeps.readPackageJson = mock(async (_workdir: string) => ({}));
    _planDeps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from("https://github.com/org/repo-name.git\n"),
      exitCode: 0,
    }));
    await planCommand(tmpDir, DEFAULT_CONFIG, { from: "/spec.md", feature: "url-shortener", auto: true });
    expect((JSON.parse(capturedWriteArgs[0][1]) as PRD).project).toBe("repo-name");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-8: branchName defaults to feat/<feature>, overridable via -b
  // ──────────────────────────────────────────────────────────────────────────

  test.each([
    ["defaults to feat/<feature>", undefined, "feat/my-feat"],
    ["can be overridden via branch option", "custom/branch-name", "custom/branch-name"],
  ] as const)("AC-8: branchName %s", async (_label, branch, expected) => {
    await planCommand(tmpDir, DEFAULT_CONFIG, {
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
      planCommand(emptyDir, DEFAULT_CONFIG, {
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
    await planCommand(tmpDir, DEFAULT_CONFIG, {
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

  test("AC-12: invokes scanSourceRoots(workdir) and renders the section in the prompt", async () => {
    const origScanSourceRoots = _planDeps.scanSourceRoots;
    const origCreateRuntime = _planDeps.createRuntime;

    // Scenario 1: verify invocation
    let scanSourceRootsWasCalled = false;
    let scanSourceRootsArg: string | undefined;
    _planDeps.scanSourceRoots = mock(async (workdir: string) => {
      scanSourceRootsWasCalled = true;
      scanSourceRootsArg = workdir;
      return [];
    });
    try {
      await planCommand(tmpDir, DEFAULT_CONFIG, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      });
      expect(scanSourceRootsWasCalled).toBe(true);
      expect(scanSourceRootsArg).toBe(tmpDir);
    } finally {
      _planDeps.scanSourceRoots = origScanSourceRoots;
    }

    // Scenario 2: verify content rendered in codebaseContext
    let capturedCodebaseContext: string | undefined;
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async (req) => {
            const prompt = req.runOptions.prompt;
            if (prompt) capturedCodebaseContext = prompt;
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
    _planDeps.scanSourceRoots = mock<typeof _planDeps.scanSourceRoots>(async (_workdir) => [
      { path: "packages/api", language: "typescript", framework: "NestJS", testRunner: "jest" },
    ]);
    try {
      await planCommand(tmpDir, DEFAULT_CONFIG, {
        from: "/spec.md",
        feature: "url-shortener",
        auto: true,
      });
      expect(capturedCodebaseContext).toContain("## Source Roots");
      expect(capturedCodebaseContext).toContain("packages/api");
    } finally {
      _planDeps.createRuntime = origCreateRuntime;
      _planDeps.scanSourceRoots = origScanSourceRoots;
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

  test("prompt: greenfield guidance, testStrategy order, workdir iff monorepo", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("greenfield project");
    expect(prompt).toContain("tdd-simple | three-session-tdd-lite | three-session-tdd | test-after");
    expect(fullPrompt(spec, ctx, undefined, ["apps/api", "apps/web"])).toContain('"workdir"');
    expect(prompt).not.toContain('"workdir"');
  });

  test.each(['"analysis"', '"contextFiles"'])("output schema includes %s field", (field) => {
    expect(fullPrompt(spec, ctx)).toContain(field);
  });

  test("taskContext excludes output schema; outputFormat contains schema but not spec steps", () => {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).not.toContain("Output Schema");
    expect(taskContext).not.toContain('"analysis": "string');
    expect(outputFormat).toContain("Output Schema");
    expect(outputFormat).toContain('"analysis"');
    expect(outputFormat).not.toContain("Step 1");
  });
});

// ─── fix #346: spec anchor rules ────────────────────────────────────────────

describe("buildPlanningPrompt — spec anchor (fix #346)", () => {
  const spec = "## Acceptance Criteria\n- AC-1: Returns 200 when project exists";
  const ctx = "## Codebase Structure\nsrc/projects/projects.service.ts";

  test("spec anchor rules in taskContext iff specContent non-empty; suggestedCriteria in outputFormat iff spec non-empty", () => {
    const { taskContext: withSpec, outputFormat: outWithSpec } = new PlanPromptBuilder().build(spec, ctx);
    const { taskContext: withoutSpec, outputFormat: outWithoutSpec } = new PlanPromptBuilder().build("", ctx);
    expect(withSpec).toContain("Preserve spec ACs");
    expect(withoutSpec).not.toContain("Preserve spec ACs");
    expect(outWithSpec).toContain("suggestedCriteria");
    expect(outWithoutSpec).not.toContain("suggestedCriteria");
  });

  test.each([["suggestedCriteria"], ["Never silently drop"], ["story scope"]])(
    "taskContext with spec contains '%s'",
    (text) => {
      const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
      expect(taskContext).toContain(text);
    },
  );
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
        runWithFallbackFn: async (req) => {
          assertDefined(req.executeHop, "req.executeHop");
          const result = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
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

  test("chat-ack on all retry attempts throws PLAN_ENVELOPE_LEAK when no prd.json; recovers from disk when present", async () => {
    // Scenario 1: no prd.json on disk → catch block re-throws PLAN_ENVELOPE_LEAK
    _planDeps.createRuntime = mock(() => makeHopInvokingRuntime());
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));
    _planDeps.readFile = mock(async () => SAMPLE_SPEC);

    await expect(
      planCommand(tmpDir993, DEFAULT_CONFIG, {
        from: "/spec.md",
        feature: "url-shortener",
      }),
    ).rejects.toThrow("envelope-shaped object");

    // Scenario 2: prd.json on disk → planCommand catch block reads it and recovers
    capturedWrites993 = [];
    _planDeps.createRuntime = mock(() => makeHopInvokingRuntime());
    _planDeps.existsSync = mock((p: string) => p.endsWith(".nax") || p.endsWith("prd.json"));
    _planDeps.readFile = mock(async (p: string) => {
      if (p.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD);
      return SAMPLE_SPEC;
    });

    const result = await planCommand(tmpDir993, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(result.outputPath).toContain("url-shortener");
    expect(result.outputPath).toContain("prd.json");
    expect(capturedWrites993.length).toBeGreaterThan(0);
    const written = JSON.parse(capturedWrites993[capturedWrites993.length - 1]?.[1] ?? "{}");
    const writtenIds = (written.userStories as Array<{ id: string; title: string }>).map((s) => s.id);
    const expectedIds = SAMPLE_PRD.userStories.map((s) => s.id);
    expect(writtenIds).toEqual(expectedIds);
  });

  test("success path: valid PRD from agent preserves all userStories (field-equality regression guard)", async () => {
    // Regression guard: on the normal success path, userStories must be preserved exactly.
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
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

    await planCommand(tmpDir993, DEFAULT_CONFIG, {
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
