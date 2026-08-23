/**
 * #507 — historyScope / neighborScope / crossPackageDepth not in config schema.
 *
 * createDefaultOrchestrator() always constructed GitHistoryProvider and
 * CodeNeighborProvider with their hardcoded defaults, ignoring any operator
 * config. This tests that the factory reads these fields from config and
 * passes them to the provider constructors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import type { ContextV2Config } from "@/config/runtime-types";
import { createDefaultOrchestrator } from "@/context/engine/orchestrator-factory";
import { _codeNeighborDeps } from "@/context/engine/providers/code-neighbor";
import { _gitHistoryDeps } from "@/context/engine/providers/git-history";
import { TestCoverageProvider, _testCoverageProviderDeps } from "@/context/engine/providers/test-coverage";
import { ToolDiagnosticsProvider, _toolDiagnosticsDeps } from "@/context/engine/providers/tool-diagnostics";
import type { ContextRequest } from "@/context/engine/types";
import type { UserStory } from "@/prd";
import { type DeepPartial, makeNaxConfig } from "@test/helpers";

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

const V2_OVERRIDE: DeepPartial<ContextV2Config> = {
  enabled: true,
  minScore: 0.1,
  deterministic: false,
  pluginProviders: [],
  stages: {},
  pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
  rules: { allowLegacyClaudeMd: true },
  session: { retentionDays: 7, archiveOnFeatureArchive: true },
  staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
};

function makeConfig(
  providerOverrides: {
    historyScope?: "repo" | "package";
    neighborScope?: "repo" | "package";
    crossPackageDepth?: number;
  } = {},
): NaxConfig {
  return makeNaxConfig({
    context: {
      v2: {
        ...V2_OVERRIDE,
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
let origCodeNeighborDetectLanguage: typeof _codeNeighborDeps.detectLanguage;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  origCodeNeighborReadFile = _codeNeighborDeps.readFile;
  origCodeNeighborGlob = _codeNeighborDeps.glob;
  origCodeNeighborDetectLanguage = _codeNeighborDeps.detectLanguage;
  // Default: suppress real FS/git calls
  _gitHistoryDeps.gitWithTimeout = async () => ({ stdout: "", exitCode: 0, stderr: "" });
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  _codeNeighborDeps.readFile = origCodeNeighborReadFile;
  _codeNeighborDeps.glob = origCodeNeighborGlob;
  _codeNeighborDeps.detectLanguage = origCodeNeighborDetectLanguage;
});

// ─────────────────────────────────────────────────────────────────────────────
// #507: historyScope respected by GitHistoryProvider
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// #508-M7: optional chaining on config.context.v2.rules
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — #508-M7 optional chaining on rules", () => {
  test("does not throw when config.context.v2.rules is undefined", () => {
    const configNoRules = makeNaxConfig({
      context: {
        v2: {
          ...V2_OVERRIDE,
          providers: { historyScope: "package", neighborScope: "package", crossPackageDepth: 1 },
          rules: undefined,
        },
      },
    });

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
      return { files: ["src/auth.ts"], truncated: false };
    };
    _codeNeighborDeps.readFile = async () => "export function auth() {}";

    const config = makeConfig({ neighborScope: "repo" });
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    await orchestrator.assemble(makeRequest());

    expect(capturedGlobDirs.some((d) => d === "/repo")).toBe(true);
  });

  test("maxGlobFiles=750 in config flows through to provider cap", async () => {
    let capturedCap: number | undefined;
    _codeNeighborDeps.glob = (_pattern, _cwd, _m, cap) => {
      capturedCap = cap;
      return { files: [], truncated: false };
    };
    const config = makeConfig();
    (config.context!.v2!.providers as any).maxGlobFiles = 750;
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    await orchestrator.assemble(makeRequest());
    expect(capturedCap).toBe(750);
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
    _testCoverageProviderDeps.generateTestCoverageSummary = async () =>
      ({
        summary: "test coverage summary",
        tokens: 100,
        files: [],
        totalTests: 5,
      }) as any;
    _testCoverageProviderDeps.resolveTestFilePatterns = async () =>
      ({ patterns: ["**/*.test.ts"], strategy: "glob" }) as any;
  });

  afterEach(() => {
    _testCoverageProviderDeps.generateTestCoverageSummary = origGenerateSummary;
    _testCoverageProviderDeps.resolveTestFilePatterns = origResolvePatterns;
    _testCoverageProviderDeps.getContextFiles = origGetContextFiles;
  });

  function makeConfigWithTestCoverage(enabled: boolean): NaxConfig {
    return makeNaxConfig({
      context: {
        v2: {
          enabled: true,
          minScore: 0.1,
          deterministic: false,
          pluginProviders: [],
          stages: {},
          pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
          rules: { allowLegacyClaudeMd: true },
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
    });
  }

  test("AC1: TestCoverageProvider is registered in providers array before additionalProviders", async () => {
    const config = makeConfigWithTestCoverage(true);
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const request = makeRequest({ providerIds: ["test-coverage"] });
    const bundle = await orchestrator.assemble(request);
    const testCoverageResult = bundle.manifest.providerResults?.find((p) => p.providerId === "test-coverage");
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

// ─────────────────────────────────────────────────────────────────────────────
// ToolDiagnosticsProvider registration (US-002 AC11)
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — ToolDiagnosticsProvider registration (US-002 AC11)", () => {
  let origToolDiagFileExists: typeof _toolDiagnosticsDeps.fileExists;
  let origToolDiagReadFile: typeof _toolDiagnosticsDeps.readFile;

  beforeEach(() => {
    origToolDiagFileExists = _toolDiagnosticsDeps.fileExists;
    origToolDiagReadFile = _toolDiagnosticsDeps.readFile;
    // Default: scratch dir absent → provider returns empty chunks
    _toolDiagnosticsDeps.fileExists = async () => false;
    _toolDiagnosticsDeps.readFile = async () => "";
  });

  afterEach(() => {
    _toolDiagnosticsDeps.fileExists = origToolDiagFileExists;
    _toolDiagnosticsDeps.readFile = origToolDiagReadFile;
  });

  test("AC11: ToolDiagnosticsProvider is registered — providerResults include id 'tool-diagnostics' after assemble", async () => {
    const config = makeConfig();
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const request = makeRequest({
      providerIds: ["tool-diagnostics"],
      storyScratchDirs: [],
    });
    const bundle = await orchestrator.assemble(request);

    const tdResult = bundle.manifest.providerResults?.find((p) => p.providerId === "tool-diagnostics");
    expect(tdResult).toBeDefined();
    expect(tdResult?.providerId).toBe("tool-diagnostics");
  });

  test("AC11: ToolDiagnosticsProvider is registered unconditionally — construction never throws", () => {
    expect(() => createDefaultOrchestrator(makeStory(), makeConfig())).not.toThrow();
  });

  test("ToolDiagnosticsProvider.fetch() emits chunks when scratch dir contains tool-diagnostics entries", async () => {
    _toolDiagnosticsDeps.fileExists = async () => true;
    _toolDiagnosticsDeps.readFile = async () =>
      `${JSON.stringify({
        kind: "tool-diagnostics",
        timestamp: "2026-01-01T00:00:00.000Z",
        storyId: "US-001",
        diagnostics: [
          { file: "src/a.ts", line: 12, severity: "error", message: "Cannot find name 'foo'.", tool: "tsc" },
        ],
      })}\n`;

    const config = makeConfig();
    const orchestrator = createDefaultOrchestrator(makeStory(), config);
    const bundle = await orchestrator.assemble(
      makeRequest({
        providerIds: ["tool-diagnostics"],
        storyScratchDirs: ["/sess/dir-a"],
      }),
    );
    const tdResult = bundle.manifest.providerResults?.find((p) => p.providerId === "tool-diagnostics");
    expect(tdResult?.status).toBe("ok");
    expect(tdResult?.chunkCount).toBeGreaterThan(0);
  });

  test("US-002 sanity: ToolDiagnosticsProvider class is the one wired into the orchestrator (smoke)", async () => {
    const orchestrator = createDefaultOrchestrator(makeStory(), makeConfig());
    // Type-level check that the class itself is constructed without args (AC1).
    expect(new ToolDiagnosticsProvider().id).toBe("tool-diagnostics");
  });
});
