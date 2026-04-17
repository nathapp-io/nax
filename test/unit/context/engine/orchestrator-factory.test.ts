/**
 * #507 — historyScope / neighborScope / crossPackageDepth not in config schema.
 *
 * createDefaultOrchestrator() always constructed GitHistoryProvider and
 * CodeNeighborProvider with their hardcoded defaults, ignoring any operator
 * config. This tests that the factory reads these fields from config and
 * passes them to the provider constructors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NaxConfig } from "../../../../src/config";
import { createDefaultOrchestrator } from "../../../../src/context/engine/orchestrator-factory";
import { _codeNeighborDeps } from "../../../../src/context/engine/providers/code-neighbor";
import { _gitHistoryDeps } from "../../../../src/context/engine/providers/git-history";
import type { ContextRequest } from "../../../../src/context/engine/types";
import type { UserStory } from "../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Test story",
    description: "desc",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    attempts: 1,
    escalations: [],
  };
}

function makeConfig(providerOverrides: {
  historyScope?: "repo" | "package";
  neighborScope?: "repo" | "package";
  crossPackageDepth?: number;
} = {}): NaxConfig {
  return {
    autoMode: { defaultAgent: "claude" },
    context: {
      v2: {
        enabled: true,
        minScore: 0.1,
        deterministic: false,
        pluginProviders: [],
        stages: {},
        pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
        rules: { allowLegacyClaudeMd: true },
        fallback: { enabled: false, onQualityFailure: false, maxHopsPerStory: 2, map: {} },
        session: { retentionDays: 7, archiveOnFeatureArchive: true },
        staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
        providers: {
          historyScope: providerOverrides.historyScope ?? "package",
          neighborScope: providerOverrides.neighborScope ?? "package",
          crossPackageDepth: providerOverrides.crossPackageDepth ?? 1,
        },
      },
    },
  } as unknown as NaxConfig;
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    featureId: "test-feature",
    repoRoot: "/repo",
    packageDir: "/repo/packages/pkg-a",
    stage: "execution",
    role: "implementer",
    budgetTokens: 10000,
    touchedFiles: ["src/auth.ts"],
    storyScratchDirs: [],
    agentId: "claude",
    ...overrides,
  } as ContextRequest;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved deps for restoration
// ─────────────────────────────────────────────────────────────────────────────

let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;
let origCodeNeighborReadFile: typeof _codeNeighborDeps.readFile;
let origCodeNeighborGlob: typeof _codeNeighborDeps.glob;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  origCodeNeighborReadFile = _codeNeighborDeps.readFile;
  origCodeNeighborGlob = _codeNeighborDeps.glob;
  // Default: suppress real FS/git calls
  _gitHistoryDeps.gitWithTimeout = async () => ({ stdout: "", exitCode: 0, stderr: "" });
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.glob = () => [];
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  _codeNeighborDeps.readFile = origCodeNeighborReadFile;
  _codeNeighborDeps.glob = origCodeNeighborGlob;
});

// ─────────────────────────────────────────────────────────────────────────────
// #507: historyScope respected by GitHistoryProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — #507 provider scope config", () => {
  test("GitHistoryProvider uses repoRoot workdir when historyScope is 'repo'", async () => {
    const capturedWorkdirs: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (_args, workdir) => {
      capturedWorkdirs.push(workdir);
      return { stdout: "abc def Fix auth bug", exitCode: 0, stderr: "" };
    };

    const config = makeConfig({ historyScope: "repo" });
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    await orchestrator.assemble(makeRequest());

    expect(capturedWorkdirs.every((w) => w === "/repo")).toBe(true);
  });

  test("GitHistoryProvider uses packageDir workdir when historyScope is 'package' (default)", async () => {
    const capturedWorkdirs: string[] = [];
    _gitHistoryDeps.gitWithTimeout = async (_args, workdir) => {
      capturedWorkdirs.push(workdir);
      return { stdout: "abc def Fix auth bug", exitCode: 0, stderr: "" };
    };

    const config = makeConfig({ historyScope: "package" });
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    await orchestrator.assemble(makeRequest());

    expect(capturedWorkdirs.every((w) => w === "/repo/packages/pkg-a")).toBe(true);
  });

  test("CodeNeighborProvider uses repoRoot workdir when neighborScope is 'repo'", async () => {
    const capturedGlobDirs: string[] = [];
    _codeNeighborDeps.glob = (_pattern, cwd) => {
      capturedGlobDirs.push(cwd);
      return ["src/auth.ts"];
    };
    _codeNeighborDeps.readFile = async () => "export function auth() {}";

    const config = makeConfig({ neighborScope: "repo" });
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    await orchestrator.assemble(makeRequest());

    expect(capturedGlobDirs.some((d) => d === "/repo")).toBe(true);
  });
});
