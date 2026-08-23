// RE-ARCH: keep
/**
 * MW-011: Greenfield detection scopes to story package workdir, not repo root.
 *
 * Scenario: monorepo root has test files in another package (apps/server), but
 * the story's target package (apps/cli) has no tests. The routing stage should
 * detect greenfield for the cli story and force test-after — NOT be fooled by
 * test files in a sibling package.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config";
import { initLogger, resetLogger } from "@/logger";
import { _routingDeps, routingStage } from "@/pipeline/stages/routing";
import type { PipelineContext } from "@/pipeline/types";
import type { UserStory } from "@/prd/types";
import { makeNaxConfig, makePRD, makeTempDir, makeTestContext } from "@test/helpers";

// ── Capture originals ─────────────────────────────────────────────────────────

const _origDeps = { ..._routingDeps };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStory(workdir?: string): UserStory {
  return {
    id: "US-001",
    title: "Config & Auth",
    description: "CLI config setup",
    acceptanceCriteria: ["Reads config from file"],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    tags: [],
    dependencies: [],
    ...(workdir ? { workdir } : {}),
  };
}

function makeCtx(story: UserStory, repoRoot: string): PipelineContext {
  return makeTestContext({
    config: makeNaxConfig({
      routing: { strategy: "llm" },
      tdd: { greenfieldDetection: true },
      autoMode: {
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: {
          enabled: false,
          tierOrder: [{ tier: "fast" }, { tier: "balanced" }, { tier: "powerful" }],
          resetMode: "initial",
        },
      },
    }),
    prd: makePRD({ project: "test", branchName: "feat/test", feature: "cli", userStories: [story] }),
    story,
    stories: [story],
    rootConfig: DEFAULT_CONFIG,
    // Phase 3: workdir is resolved at context creation — include story.workdir if set
    workdir: story.workdir ? join(repoRoot, story.workdir) : repoRoot,
    projectDir: repoRoot,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "three-session-tdd", reasoning: "" },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MW-011: greenfield detection scopes to story package workdir", () => {
  let repoRoot: string;

  beforeEach(async () => {
    initLogger({ level: "silent" });
    repoRoot = makeTempDir("nax-mw011-");

    // Set up monorepo structure
    await mkdir(join(repoRoot, "apps", "server", "src"), { recursive: true });
    await mkdir(join(repoRoot, "apps", "cli", "src"), { recursive: true });

    // server package has tests — cli package has none
    await writeFile(
      join(repoRoot, "apps", "server", "src", "server.test.ts"),
      "import { describe, it } from 'bun:test'; describe('server', () => { it('works', () => {}); });",
    );
    await writeFile(join(repoRoot, "apps", "cli", "src", "index.ts"), "export function run() {}");

    // Mock routing to always return three-session-tdd for simple stories
    _routingDeps.resolveRouting = mock(async () => ({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "mock classification",
    }));
    _routingDeps.complexityToModelTier = mock(() => "fast" as const);
    // Stub the ADR-009 SSOT resolver to broad globs so this test exercises the
    // greenfield filesystem SCOPING (which package dir is scanned) via the real
    // isGreenfieldStory — independent of detection-tier fs/git behaviour.
    _routingDeps.resolveTestFilePatterns = mock(async () => ({
      globs: ["**/*.test.ts", "**/*.spec.ts"],
      pathspec: [],
      regex: [],
      testDirs: [],
      resolution: "detected" as const,
    }));
    _routingDeps.savePRD = mock(async () => {});
    _routingDeps.computeStoryContentHash = mock(() => "hash1");
    _routingDeps.routeBatch = undefined /* routeBatch deleted ROUTE-001 */;
  });

  afterEach(async () => {
    Object.assign(_routingDeps, _origDeps);
    resetLogger();
    await rm(repoRoot, { recursive: true, force: true });
  });

  test("story with workdir=apps/cli detects greenfield — security-critical keeps three-session-tdd", async () => {
    // Use the REAL isGreenfieldStory (not mocked) so it scans the filesystem
    _routingDeps.isGreenfieldStory = _origDeps.isGreenfieldStory;

    const story = makeStory("apps/cli");
    // "Config & Auth" title contains "auth" → isSecurityCriticalStory returns true
    // Security-critical greenfield: three-session-tdd is preserved (no downgrade)
    story.routing = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "cached",
      contentHash: "hash1",
    };
    const ctx = makeCtx(story, repoRoot);

    const result = await routingStage.execute(ctx);

    expect(result.action).toBe("continue");
    // Greenfield + security-critical → three-session-tdd preserved
    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
    expect(ctx.routing.reasoning).not.toContain("GREENFIELD OVERRIDE");
  });

  test("story without workdir scans repo root — not greenfield when root has tests", async () => {
    // Move a test file to repo root level
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(
      join(repoRoot, "src", "main.test.ts"),
      "import { describe, it } from 'bun:test'; describe('main', () => { it('works', () => {}); });",
    );

    _routingDeps.isGreenfieldStory = _origDeps.isGreenfieldStory;

    const story = makeStory(); // no workdir — uses repoRoot
    story.routing = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "cached",
      contentHash: "hash1",
    };
    const ctx = makeCtx(story, repoRoot);

    await routingStage.execute(ctx);

    // Repo root has tests → NOT greenfield → three-session-tdd preserved
    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
  });

  test("server story is not greenfield because its own package has tests", async () => {
    _routingDeps.isGreenfieldStory = _origDeps.isGreenfieldStory;

    const story = makeStory("apps/server");
    story.routing = {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "three-session-tdd",
      reasoning: "cached",
      contentHash: "hash1",
    };
    const ctx = makeCtx(story, repoRoot);

    await routingStage.execute(ctx);

    // apps/server has tests → NOT greenfield → strategy preserved
    expect(ctx.routing.testStrategy).toBe("three-session-tdd");
  });
});
