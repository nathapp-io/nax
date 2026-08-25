/**
 * Integration test — plan-time agent selection (ADR-025 Part C)
 *
 * AC: When the plan agent emits `routing.agentProfileId` for a story, the
 * written prd.json must have:
 *   - userStories[0].routing.agent  resolved from the matching profile target
 *   - userStories[0].routing.agentProfileId  preserved
 *   - routingProfile  set to the config.profile value
 *
 * Uses the established `_planDeps` injection pattern from plan-callop.test.ts
 * and plan-prd-preservation.test.ts. The agent is stubbed via `_planDeps.createRuntime`
 * so no real LLM calls are made.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _planDeps, planCommand } from "@/cli";
import type { PRD } from "@/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature: plan-agent-selection
## Problem
Implement plan-time agent selection.
## Acceptance Criteria
- AC-1: The plan emits agentProfileId
`;

/**
 * Minimal PRD that the stubbed agent "writes" via its output.
 * Story US-001 has routing.agentProfileId = "claude-final" so finalizePrdRouting
 * should resolve that to agent "claude" (matched from the config profiles below).
 */
const SAMPLE_PRD_WITH_PROFILE_ID: PRD = {
  project: "test-project",
  feature: "plan-agent-selection",
  branchName: "feat/plan-agent-selection",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Emit agentProfileId",
      description: "Plan agent emits agentProfileId for routing",
      acceptanceCriteria: ["AC-1: agentProfileId written to prd.json"],
      tags: ["feature"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "medium",
        testStrategy: "test-after",
        reasoning: "Core routing feature",
        agentProfileId: "claude-final",
      },
    },
  ],
};

/**
 * Config with two agent profiles:
 *   "opencode-structural" → opencode / fast
 *   "claude-final"        → claude / balanced
 *
 * profile = "cross-agent" so routingProfile in the output should be "cross-agent".
 *
 * Uses makeNaxConfig so DEFAULT_CONFIG supplies all required fields (plan.model,
 * plan.outputPath, etc.) before our overrides are applied.
 */
const CONFIG = makeNaxConfig({
  plan: { mode: "single" },
  profile: "cross-agent",
  routing: {
    strategy: "keyword",
    agents: {
      enabled: true,
      strategy: "off",
      default: "claude-final",
      profiles: [
        {
          id: "opencode-structural",
          target: { agent: "opencode", model: "fast" },
          strengths: ["structural refactoring"],
        },
        {
          id: "claude-final",
          target: { agent: "claude", model: "balanced" },
          strengths: ["complex reasoning"],
        },
      ],
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals — restored unconditionally in afterEach
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanSourceRoots = _planDeps.scanSourceRoots;
const origCreateRuntime = _planDeps.createRuntime;
const origReadPackageJson = _planDeps.readPackageJson;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;
const origInitInteractionChain = _planDeps.initInteractionChain;
const origCreateInteractionBridge = _planDeps.createInteractionBridge;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — plan-time agent selection (ADR-025 Part C)", () => {
  let tmpDir: string;
  let outputPath: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-agent-sel-");
    const featureDir = join(tmpDir, ".nax", "features", "plan-agent-selection");
    outputPath = join(featureDir, "prd.json");

    await mkdir(join(tmpDir, ".nax"), { recursive: true });
    await mkdir(featureDir, { recursive: true });

    // Stub readFile: return spec for the spec path; PRD JSON for prd.json path.
    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD_WITH_PROFILE_ID);
      return SAMPLE_SPEC;
    });

    // Stub writeFile: write to real disk so we can read it back in assertions.
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      await Bun.write(path, content);
    });

    _planDeps.existsSync = mock((path: string) => path === join(tmpDir, ".nax"));

    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => ({}));

    _planDeps.spawnSync = mock(() => ({
      stdout: Buffer.from(""),
      exitCode: 1,
    }));

    _planDeps.mkdirp = mock(async () => {});
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.initInteractionChain = mock(async () => null);
    _planDeps.createInteractionBridge = mock(() => ({
      detectQuestion: mock(async () => false),
      onQuestionDetected: mock(async () => ""),
    }));

    // Stub createRuntime: return a mock runtime whose agent emits the PRD JSON
    // containing routing.agentProfileId = "claude-final".
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: JSON.stringify(SAMPLE_PRD_WITH_PROFILE_ID),
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
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.initInteractionChain = origInitInteractionChain;
    _planDeps.createInteractionBridge = origCreateInteractionBridge;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    cleanupTempDir(tmpDir);
  });

  test("resolves agentProfileId to agent and stamps routingProfile in written prd.json", async () => {
    const specPath = join(tmpDir, "spec.md");
    await Bun.write(specPath, SAMPLE_SPEC);

    const result = await planCommand(tmpDir, CONFIG, {
      from: specPath,
      feature: "plan-agent-selection",
    });

    // planCommand must return the prd.json path
    expect(result.outputPath).toContain("prd.json");
    expect(result.outputPath).toContain("plan-agent-selection");

    // Read the written prd.json from disk
    const written = await Bun.file(outputPath).text();
    const prd = JSON.parse(written) as PRD;

    // AC: agentProfileId resolved to agent "claude" (from "claude-final" profile target)
    expect(prd.userStories[0].routing?.agent).toBe("claude");

    // AC: agentProfileId preserved on the story
    expect(prd.userStories[0].routing?.agentProfileId).toBe("claude-final");

    // AC: routingProfile stamped from config.profile = "cross-agent"
    expect(prd.routingProfile).toBe("cross-agent");
  });
});
