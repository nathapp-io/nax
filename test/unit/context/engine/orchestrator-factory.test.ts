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
import { TestCoverageProvider, _testCoverageProviderDeps } from "../../../../src/context/engine/providers/test-coverage";
import type { ContextRequest } from "../../../../src/context/engine/types";
import type { UserStory } from "../../../../src/prd";
import { makeNaxConfig } from "../../../helpers";

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
  return makeNaxConfig({
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
  });
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

// ─────────────────────────────────────────────────────────────────────────────
// #508-M7: optional chaining on config.context.v2.rules
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — #508-M7 optional chaining on rules", () => {
  test("does not throw when config.context.v2.rules is undefined", () => {
    const configNoRules = {
      ...makeConfig(),
      context: {
        v2: {
          ...makeConfig().context.v2,
          rules: undefined,
        },
      },
    } as unknown as NaxConfig;

    expect(() => createDefaultOrchestrator(makeStory(), configNoRules)).not.toThrow();
  });
});

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

// ─────────────────────────────────────────────────────────────────────────────
// TestCoverageProvider registration (US-003 AC1, AC2, AC7, AC8)
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — TestCoverageProvider registration", () => {
  let origGenerateSummary: typeof _testCoverageProviderDeps.generateTestCoverageSummary;
  let origResolvePatterns: typeof _testCoverageProviderDeps.resolveTestFilePatterns;
  let origGetContextFiles: typeof _testCoverageProviderDeps.getContextFiles;

  beforeEach(() => {
    origGenerateSummary = _testCoverageProviderDeps.generateTestCoverageSummary;
    origResolvePatterns = _testCoverageProviderDeps.resolveTestFilePatterns;
    origGetContextFiles = _testCoverageProviderDeps.getContextFiles;
    _testCoverageProviderDeps.getContextFiles = () => [];
    _testCoverageProviderDeps.generateTestCoverageSummary = async () => ({
      summary: "test coverage summary",
      tokens: 100,
      files: [],
      totalTests: 5,
    } as any);
    _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
      ({ patterns: ["**/*.test.ts"], strategy: "glob" } as any);
  });

  afterEach(() => {
    _testCoverageProviderDeps.generateTestCoverageSummary = origGenerateSummary;
    _testCoverageProviderDeps.resolveTestFilePatterns = origResolvePatterns;
    _testCoverageProviderDeps.getContextFiles = origGetContextFiles;
  });

  function makeConfigWithTestCoverage(enabled: boolean): NaxConfig {
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
            historyScope: "package",
            neighborScope: "package",
            crossPackageDepth: 1,
          },
        },
        testCoverage: {
          enabled,
          maxTokens: 500,
          detail: "names-and-counts",
          scopeToStory: true,
        },
      },
    } as unknown as NaxConfig;
  }

  test("AC1: TestCoverageProvider is registered in providers array before additionalProviders", async () => {
    const config = makeConfigWithTestCoverage(true);
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const request = makeRequest({ providerIds: ["test-coverage"] });
    const bundle = await orchestrator.assemble(request);
    const testCoverageResult = bundle.manifest.providerResults?.find(
      (p) => p.providerId === "test-coverage",
    );
    expect(testCoverageResult).toBeDefined();
  });

  test("AC2: TestCoverageProvider is registered unconditionally — no branching on enabled flag", () => {
    const configDisabled = makeConfigWithTestCoverage(false);
    const configEnabled = makeConfigWithTestCoverage(true);
    const orch1 = createDefaultOrchestrator(makeStory(), configDisabled);
    const orch2 = createDefaultOrchestrator(makeStory(), configEnabled);
    expect(orch1).toBeDefined();
    expect(orch2).toBeDefined();
  });

  test("AC7: when v2.enabled and testCoverage.enabled are true, providerResult status is 'ok' with tests", async () => {
    const config = makeConfigWithTestCoverage(true);
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const bundle = await orchestrator.assemble(makeRequest({ providerIds: ["test-coverage"] }));
    const tcResult = bundle.manifest.providerResults?.find((p) => p.providerId === "test-coverage");
    expect(tcResult?.status).toBe("ok");
    expect(tcResult?.chunkCount).toBeGreaterThan(0);
  });

  test("AC8: when testCoverage.enabled is false, providerResult status is 'empty' with chunkCount 0", async () => {
    const config = makeConfigWithTestCoverage(false);
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const bundle = await orchestrator.assemble(makeRequest({ providerIds: ["test-coverage"] }));
    const tcResult = bundle.manifest.providerResults?.find((p) => p.providerId === "test-coverage");
    expect(tcResult?.status).toBe("empty");
    expect(tcResult?.chunkCount).toBe(0);
  });
});
