/**
 * Unit tests for planCommand (PLN-001)
 *
 * Tests new behavior: prd.json output, --auto mode, --from spec path,
 * project auto-detection, branchName defaults, JSON validation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, buildPlanComposition, planCommand } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import type { PRD } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";
import { makeMockAgentManager, makeMockRuntime, makeTempDir } from "@test/helpers";

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
const origScanCodebase = _planDeps.scanCodebase;
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

    _planDeps.existsSync = mock((path: string) => path.endsWith("prd.json"));

    _planDeps.scanCodebase = mock(async (_workdir: string) => makeFakeScan());

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
            return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
          },
        }),
      });
    });
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
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

  test("AC-2: prompt includes codebase context", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedPlanArgs[0];
    expect(prompt).toContain("Codebase");
    expect(prompt).toContain("express");
  });

  test("uses explicit plan model selector to choose adapter", async () => {
    let receivedAgentName: string | undefined;

    _planDeps.createRuntime = mock((cfg: any) =>
      makeMockRuntime({
        config: cfg,
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async (_req, primaryAgentOverride) => {
            receivedAgentName = primaryAgentOverride;
            return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
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

  test("AC-2: prompt includes output schema with prd.json structure", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedPlanArgs[0];
    expect(prompt).toContain("userStories");
    expect(prompt).toContain("acceptanceCriteria");
    expect(prompt).toContain("dependencies");
  });

  test("AC-2: prompt includes complexity classification guide", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedPlanArgs[0];
    expect(prompt).toContain("simple");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("complex");
    expect(prompt).toContain("expert");
  });

  test("AC-2: prompt includes test strategy guide", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const prompt = capturedPlanArgs[0];
    expect(prompt).toContain("test-after");
    expect(prompt).toContain("tdd-lite");
    expect(prompt).toContain("three-session-tdd");
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
            return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
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
          runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: "not valid json {{", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
        }),
      }),
    );
    _planDeps.existsSync = mock(() => false);

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
          runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: JSON.stringify(prdWithoutProject), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
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
          runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: JSON.stringify(badPrd), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
        }),
      }),
    );
    _planDeps.existsSync = mock(() => false);

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

  test("AC-5: output path is nax/features/<feature>/prd.json", async () => {
    const result = await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "url-shortener",
      auto: true,
    });

    const expectedPath = join(tmpDir, ".nax", "features", "url-shortener", "prd.json");
    expect(result).toBe(expectedPath);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);
  });

  test("AC-5: written content is valid JSON with PRD structure", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
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

    _planDeps.createRuntime = mock((_cfg: any) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: JSON.stringify(prdWithBadStatuses), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
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

  test("AC-8: branchName defaults to feat/<feature>", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
      from: "/spec.md",
      feature: "my-feat",
      auto: true,
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.branchName).toBe("feat/my-feat");
  });

  test("AC-8: branchName can be overridden via branch option", async () => {
    await planCommand(tmpDir, DEFAULT_CONFIG as never, {
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
    const emptyDir = makeTempDir("nax-plan-empty-");
    await rm(join(emptyDir, ".nax"), { recursive: true, force: true });

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

  test("prompt has Step 1 — understand the spec", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("Understand the Spec");
  });

  test("prompt has Step 2 — analyze", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("Step 2");
    expect(prompt).toContain("Analyze");
  });

  test("prompt has Step 3 — generate stories", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("Step 3");
    expect(prompt).toContain("Generate Implementation Stories");
  });

  test("prompt handles greenfield guidance", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("greenfield project");
  });

  test("output schema includes analysis field", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain('"analysis"');
  });

  test("output schema includes contextFiles field", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain('"contextFiles"');
  });

  test("testStrategy list is in correct order (tdd-simple first, test-after last)", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).toContain("tdd-simple | three-session-tdd-lite | three-session-tdd | test-after");
  });

  test("monorepo: includes workdir field in schema", () => {
    const prompt = fullPrompt(spec, ctx, undefined, ["apps/api", "apps/web"]);
    expect(prompt).toContain('"workdir"');
  });

  test("non-monorepo: no workdir field in schema", () => {
    const prompt = fullPrompt(spec, ctx);
    expect(prompt).not.toContain('"workdir"');
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

  test("spec anchor rules included in taskContext when specContent is non-empty", () => {
    const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).toContain("Preserve spec ACs");
  });

  test("spec anchor rules NOT included when specContent is empty string", () => {
    const { taskContext } = new PlanPromptBuilder().build("", ctx);
    expect(taskContext).not.toContain("Preserve spec ACs");
  });

  test("taskContext tells planner to put invented ACs in suggestedCriteria", () => {
    const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).toContain("suggestedCriteria");
  });

  test("outputFormat schema includes suggestedCriteria field when spec is provided", () => {
    const { outputFormat } = new PlanPromptBuilder().build(spec, ctx);
    expect(outputFormat).toContain("suggestedCriteria");
  });

  test("outputFormat schema does NOT include suggestedCriteria when spec is empty", () => {
    const { outputFormat } = new PlanPromptBuilder().build("", ctx);
    expect(outputFormat).not.toContain("suggestedCriteria");
  });

  test("taskContext instructs planner to never drop a spec AC", () => {
    const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).toContain("Never silently drop");
  });

  test("taskContext instructs planner to keep story scope — no cross-story ACs", () => {
    const { taskContext } = new PlanPromptBuilder().build(spec, ctx);
    expect(taskContext).toContain("story scope");
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

    _planDeps.scanCodebase = mock(async () => ({
      fileTree: "└── src/\n    └── index.ts",
      dependencies: {},
      devDependencies: {},
      testPatterns: [],
    }));
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
    _planDeps.existsSync = mock(() => false);
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
    _planDeps.existsSync = mock((p: string) => p.endsWith("prd.json"));
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
    _planDeps.existsSync = mock(() => false);
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

  test("AC-1: returns config unchanged when evidenceMode is 'current'", () => {
    const input = { ...baseConfig, sessionMode: "one-shot" as const, evidenceMode: "current" as const };
    const result = buildPlanComposition(input);
    expect(result).toBe(input);
  });

  test("AC-1: returns config unchanged when evidenceMode is absent", () => {
    const input = { ...baseConfig, sessionMode: "one-shot" as const };
    const result = buildPlanComposition(input as any);
    expect(result).toBe(input);
  });

  test("AC-1: injects preDebatePhase grounder when evidenceMode is 'asymmetric'", () => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const });
    expect(result.preDebatePhase).toEqual({ kind: "grounder" });
  });

  test("AC-1: injects proposers constraints when evidenceMode is 'asymmetric'", () => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const });
    expect(result.proposers).toEqual({ citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 });
  });

  test("AC-1: sets sessionMode to stateful when evidenceMode is 'asymmetric'", () => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const });
    expect(result.sessionMode).toBe("stateful");
  });

  test("AC-1: sets verifier-pick selector with patch when evidenceMode is 'asymmetric'", () => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const });
    expect(result.selector).toEqual({ kind: "verifier-pick", patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 } });
  });

  test("AC-1: injects plan-checklist postDebateVerifier when evidenceMode is 'asymmetric'", () => {
    const result = buildPlanComposition({ ...baseConfig, evidenceMode: "asymmetric" as const });
    expect(result.postDebateVerifier).toEqual({ kind: "plan-checklist" });
  });

  test("AC-2: user-specified preDebatePhase overrides asymmetric default", () => {
    const result = buildPlanComposition({
      ...baseConfig,
      evidenceMode: "asymmetric" as const,
      preDebatePhase: { kind: "custom" as const, onFailure: "block" as const },
    });
    expect(result.preDebatePhase).toEqual({ kind: "custom", onFailure: "block" });
  });

  test("AC-2: user-specified selector overrides asymmetric default", () => {
    const result = buildPlanComposition({
      ...baseConfig,
      evidenceMode: "asymmetric" as const,
      selector: { kind: "synthesis" as const },
    });
    expect(result.selector).toEqual({ kind: "synthesis" });
  });

  test("AC-2: user-specified sessionMode overrides asymmetric default", () => {
    // User explicitly sets one-shot — should not be replaced with stateful default.
    const result = buildPlanComposition({
      ...baseConfig,
      sessionMode: "one-shot" as const,
      evidenceMode: "asymmetric" as const,
    });
    expect(result.sessionMode).toBe("one-shot");
  });

  test("AC-2: user-specified proposers override asymmetric default", () => {
    const result = buildPlanComposition({
      ...baseConfig,
      evidenceMode: "asymmetric" as const,
      proposers: { citationsRequired: false },
    });
    expect(result.proposers).toEqual({ citationsRequired: false });
  });
});
