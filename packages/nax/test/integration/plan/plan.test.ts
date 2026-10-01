/**
 * Integration tests for the plan command surface.
 *
 * Merged from two files:
 *   - planCommand / PlanOptions / PlanResult wiring (mocked `_planDeps`)
 *   - issue #993 regression: prd.json preservation via op.recover
 *
 * The original ticket file was `plan-prd-preservation.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeTempDir,
} from "@test/helpers";
import { _planDeps, planCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config/schema";
import type { PRD } from "@/prd/types";

describe("planCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-plan-${Date.now()}`;
    await mkdir(`${tmpDir}/nax`, { recursive: true });
    await mkdir(`${tmpDir}/src`, { recursive: true });

    // Create minimal package.json
    await Bun.write(
      `${tmpDir}/package.json`,
      JSON.stringify({
        name: "test-project",
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
    );

    // Create minimal source file
    await Bun.write(`${tmpDir}/src/index.ts`, "export const app = {};\n");
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws when nax not initialized", async () => {
    const emptyDir = `/tmp/nax-plan-empty-${Date.now()}`;
    await mkdir(emptyDir, { recursive: true });

    expect(planCommand(emptyDir, DEFAULT_CONFIG, { from: "spec.md", feature: "add-feature-x" })).rejects.toThrow(
      "nax directory not found",
    );

    await rm(emptyDir, { recursive: true, force: true });
  });

  test("validates config.plan settings", () => {
    const config: NaxConfig = makeNaxConfig({
      plan: {
        model: "balanced",
        outputPath: "spec.md",
      },
    });

    expect(config.plan.model).toBe("balanced");
    expect(config.plan.outputPath).toBe("spec.md");
  });

  test("resolves model tier from config", () => {
    const config: NaxConfig = makeNaxConfig({
      plan: {
        model: "powerful",
        outputPath: "spec.md",
      },
    });

    expect(config.plan.model).toBe("powerful");
    expect(config.models[config.agent?.default ?? "claude"]?.powerful).toBeDefined();
  });

  test("builds codebase context from scanner", async () => {
    // This test would require mocking the agent adapter
    // For now, we just verify the structure is set up correctly
    const config: NaxConfig = makeNaxConfig({
      plan: {
        model: "balanced",
        outputPath: "custom-spec.md",
      },
    });

    expect(config.plan.outputPath).toBe("custom-spec.md");
  });

  test("uses default plan config values", () => {
    expect(DEFAULT_CONFIG.plan.model).toBe("balanced");
    expect(DEFAULT_CONFIG.plan.outputPath).toBe("spec.md");
  });

  test("supports custom output path", () => {
    const config: NaxConfig = makeNaxConfig({
      plan: {
        model: "balanced",
        outputPath: "features/planning.md",
      },
    });

    expect(config.plan.outputPath).toBe("features/planning.md");
  });

  test("validates model tier options", () => {
    const validTiers: Array<"fast" | "balanced" | "powerful"> = ["fast", "balanced", "powerful"];

    for (const tier of validTiers) {
      const config: NaxConfig = makeNaxConfig({
        plan: {
          model: tier,
          outputPath: "spec.md",
        },
      });

      expect(config.plan.model).toBe(tier);
      expect(config.models[config.agent?.default ?? "claude"]?.[tier]).toBeDefined();
    }
  });
});

describe("PlanOptions and PlanResult types", () => {
  test("PlanOptions structure is valid", () => {
    // Type-only test — ensures TypeScript accepts the structure
    const options = {
      prompt: "Add URL shortener",
      workdir: "/project",
      interactive: true,
      codebaseContext: "File tree:\nsrc/\n",
      inputFile: undefined,
      modelTier: "balanced" as const,
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    };

    expect(options.prompt).toBe("Add URL shortener");
    expect(options.interactive).toBe(true);
  });

  test("PlanResult structure is valid", () => {
    // Type-only test — ensures TypeScript accepts the structure
    const result = {
      specContent: "# Feature: URL Shortener\n\n## Problem\n...",
      conversationLog: "Agent: What storage?\nUser: PostgreSQL\n",
    };

    expect(result.specContent).toContain("Feature: URL Shortener");
  });

  test("non-interactive mode uses inputFile", () => {
    const options = {
      prompt: "Implement feature",
      workdir: "/project",
      interactive: false,
      inputFile: "/tmp/input.md",
    };

    expect(options.interactive).toBe(false);
    expect(options.inputFile).toBe("/tmp/input.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// issue #993 regression: prd.json preservation
//
// AC1: When the agent declines to regenerate an existing valid prd.json
// (returning chat acknowledgements on every turn), the op.recover path reads
// the real file from disk and the planCommand returns with userStories intact.
//
// Unlike the mocked-`_planDeps` tests above, the prd.json here is a real file
// on disk so op.recover actually reads it via Bun.file(outputPath).text(),
// exercising the full recovery path end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

const EXISTING_PRD: PRD = {
  project: "my-project",
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
    {
      id: "US-002",
      title: "Redirect URL",
      description: "Short URL redirects to original",
      acceptanceCriteria: ["AC-2: Redirect returns 302"],
      tags: ["feature"],
      dependencies: ["US-001"],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "HTTP redirect",
      },
    },
  ],
};

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origCreateRuntime = _planDeps.createRuntime;
const origReadPackageJson = _planDeps.readPackageJson;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;

describe("plan PRD preservation — issue #993 regression (AC1)", () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-prd-preservation-");
    const featureDir = join(tmpDir, ".nax", "features", "url-shortener");
    outputPath = join(featureDir, "prd.json");

    // Write real prd.json on disk so op.recover can read it via Bun.file()
    await mkdir(featureDir, { recursive: true });
    await Bun.write(outputPath, JSON.stringify(EXISTING_PRD, null, 2));

    // Stub infrastructure deps
    _planDeps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async (_path: string) => {});
    _planDeps.existsSync = mock((_p: string) => true);

    // readFile: return spec content for the spec path; real file read for prd.json paths.
    // op.recover bypasses _planDeps.readFile entirely (uses Bun.file directly), but the
    // cli/plan.ts catch-block recovery does use _planDeps.readFile for the secondary path.
    _planDeps.readFile = mock(async (p: string) => {
      if (p === outputPath) return Bun.file(p).text();
      return "# Spec\n## Acceptance Criteria\n- AC-1: URL shortened";
    });

    // writeFile: write to real disk so we can verify the output
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      await Bun.write(path, content);
    });
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.createRuntime = origCreateRuntime;
    // Pre-AC-14 stale property: ensure no scanCodebase leaks to subsequent tests
    delete (_planDeps as { scanCodebase?: unknown }).scanCodebase;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    cleanupTempDir(tmpDir);
  });

  test("AC1: agent returns chat ack on all turns — prd.json userStories preserved via op.recover", async () => {
    // Simulate issue #993: agent declines regeneration on every retry attempt.
    // With the fix, callOp invokes op.recover which reads the real prd.json
    // from disk. planCommand writes back the recovered PRD. userStories unchanged.
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runAsSessionFn: async () => ({
            output: "File already valid and complete. No rewrite needed.",
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
            internalRoundTrips: 0,
          }),
          runWithFallbackFn: async (req) => {
            const { executeHop } = req;
            assertDefined(executeHop, "req.executeHop");
            const result = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
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
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    // Read the written prd.json from real disk
    const afterContent = await Bun.file(outputPath).text();
    const afterPrd = JSON.parse(afterContent) as PRD;

    // Field-equality on stable identity fields — validatePlanOutput may transform
    // routing.reasoning, so compare ids/titles rather than the full object.
    // Core invariant: all story IDs are preserved (nothing overwritten by envelope).
    expect(afterPrd.userStories).toHaveLength(EXISTING_PRD.userStories.length);
    expect(afterPrd.userStories.map((s) => s.id)).toEqual(EXISTING_PRD.userStories.map((s) => s.id));
    expect(afterPrd.userStories.map((s) => s.title)).toEqual(EXISTING_PRD.userStories.map((s) => s.title));
  });
});
