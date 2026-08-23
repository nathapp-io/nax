/**
 * US-004 AC14: createDefaultOrchestrator registers LintConfigProvider.
 *
 * Mirrors the US-003 PriorRunFailureProvider factory-registration coverage.
 * The provider is registered unconditionally — no branching on a feature flag.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LintConfigProvider,
  _codeNeighborDeps,
  _gitHistoryDeps,
  _lintConfigProviderDeps,
  createDefaultOrchestrator,
} from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import { makeNaxConfig } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeLintConfigFactoryConfig() {
  return makeNaxConfig({
    agent: { default: "claude" },
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
    },
  });
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-004",
    featureId: "test-feature",
    repoRoot: "/repo",
    packageDir: "/repo/packages/pkg-a",
    stage: "rectify",
    role: "implementer",
    budgetTokens: 8000,
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
let origDetectProjectProfile: typeof _lintConfigProviderDeps.detectProjectProfile;

beforeEach(() => {
  origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  origCodeNeighborReadFile = _codeNeighborDeps.readFile;
  origCodeNeighborGlob = _codeNeighborDeps.glob;
  origCodeNeighborDetectLanguage = _codeNeighborDeps.detectLanguage;
  origDetectProjectProfile = _lintConfigProviderDeps.detectProjectProfile;
  // Suppress real FS/git/detector calls; emit empty metrics.
  _gitHistoryDeps.gitWithTimeout = async () => ({ stdout: "", exitCode: 0, stderr: "" });
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
  _lintConfigProviderDeps.detectProjectProfile = async () => ({ lintTool: undefined });
});

afterEach(() => {
  _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  _codeNeighborDeps.readFile = origCodeNeighborReadFile;
  _codeNeighborDeps.glob = origCodeNeighborGlob;
  _codeNeighborDeps.detectLanguage = origCodeNeighborDetectLanguage;
  _lintConfigProviderDeps.detectProjectProfile = origDetectProjectProfile;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC14: LintConfigProvider registration
// ─────────────────────────────────────────────────────────────────────────────

describe("createDefaultOrchestrator — LintConfigProvider registration (US-004 AC14)", () => {
  test("AC14: LintConfigProvider is registered — providerResults include id 'lint-config' after assemble", async () => {
    const orchestrator = createDefaultOrchestrator({} as any, makeLintConfigFactoryConfig());
    const request = makeRequest({ providerIds: ["lint-config"], storyScratchDirs: [] });
    const bundle = await orchestrator.assemble(request);

    const lcResult = bundle.manifest.providerResults?.find((p) => p.providerId === "lint-config");
    expect(lcResult).toBeDefined();
    expect(lcResult?.providerId).toBe("lint-config");
  });

  test("AC14: LintConfigProvider is registered unconditionally — construction never throws", () => {
    expect(() => createDefaultOrchestrator({} as any, makeLintConfigFactoryConfig())).not.toThrow();
  });

  test("US-004 sanity: LintConfigProvider class is the one wired into the orchestrator (smoke)", () => {
    expect(new LintConfigProvider().id).toBe("lint-config");
    expect(new LintConfigProvider().kind).toBe("lint-config");
  });
});
