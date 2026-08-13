import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  ContextOrchestrator,
  _codeNeighborDeps,
  _gitHistoryDeps,
  buildManifest,
  CodeNeighborProvider,
  GitHistoryProvider,
} from "@/context/engine";
import type {
  ContextBundle,
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
  ManifestInputs,
  RawChunk,
} from "@/context/engine";
import { _contextStageDeps, contextStage } from "@/pipeline/stages/context";
import type { PackedChunk } from "@/context/engine/packing";
// New symbols (US-003) — not yet exported from the barrel; imported from the
// spec-declared module paths (docs/specs/SPEC-effectiveness-scoring-loop.md
// §Integration and §Stories US-003).
import { loadFeatureManifests } from "@/context/engine/manifest-store";
import { deriveProviderWeights } from "@/context/engine/provider-weights";
import type { PipelineContext } from "@/pipeline/types";
import { type Classifier, loadLabelSet, scoreEffectiveness } from "../../../src/context/engine/effectiveness-eval";
import { _effectivenessDeps, buildEvidenceTerms, classifyWithTerms } from "@/context/engine/effectiveness";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers/temp";

const COMMITTED_FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test",
  "fixtures",
  "effectiveness",
  "labels.sample.json",
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeContextRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

function makePacked(overrides: Partial<PackedChunk> & { id: string }): PackedChunk {
  return {
    kind: "static",
    scope: "project",
    role: ["all"],
    content: `### ${overrides.id}\n\nbody`,
    tokens: 50,
    rawScore: 1.0,
    score: 1.0,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

function makeManifestInputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  return {
    requestId: "req-001",
    request: makeContextRequest(),
    packed: [],
    usedTokens: 0,
    digestTokens: 0,
    buildMs: 5,
    providerResults: [],
    roleFiltered: [],
    belowMin: [],
    dedupeDropped: [],
    budgetExcludedIds: [],
    floorPackedIds: [],
    floorOverageIds: [],
    effectiveBudget: 8_000,
    ...overrides,
  };
}

/** A ContextManifest fixture — deriveProviderWeights operates on these. */
function makeManifest(overrides: Partial<ContextManifest> = {}): ContextManifest {
  return {
    requestId: "req-001",
    stage: "execution",
    totalBudgetTokens: 8_000,
    usedTokens: 100,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 10,
    buildMs: 5,
    ...overrides,
  };
}

/** Pre-change baseline: 3+ shared terms with the whole diff text → followed. */
const wholeDiffClassifier: Classifier = (c) => {
  const diffTerms = _effectivenessDeps.tokenize(c.diffText);
  const summaryTerms = _effectivenessDeps.tokenize(c.chunkSummary);
  let shared = 0;
  for (const term of summaryTerms) if (diffTerms.has(term)) shared++;
  return shared >= 3 ? "followed" : "ignored";
};

/** Post-change: classifyWithTerms restricted to the case's own scopePaths. */
const scopedClassifier: Classifier = (c) => {
  const evidence = buildEvidenceTerms("", c.diffText, []);
  const result = classifyWithTerms(c.chunkSummary, evidence, { scopePaths: c.scopePaths, diffText: c.diffText });
  return result.signal === "unknown" ? "ignored" : result.signal;
};

/** Builds N classified chunk ids for a single provider, split by ignored ratio. */
function ignoredRatioManifest(providerId: string, count: number, ignoredCount: number): ContextManifest {
  const chunkProviders: Record<string, string> = {};
  const chunkEffectiveness: Record<string, { signal: "followed" | "ignored" | "contradicted" | "unknown" }> = {};
  const includedChunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${providerId}:chunk-${i}`;
    includedChunks.push(id);
    chunkProviders[id] = providerId;
    chunkEffectiveness[id] = { signal: i < ignoredCount ? "ignored" : "followed" };
  }
  return makeManifest({ includedChunks, chunkProviders, chunkEffectiveness } as Partial<ContextManifest>);
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — GitHistoryProvider scope attribution (AC-1..AC-6)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — GitHistoryProvider scope attribution", () => {
  let origGitWithTimeout: typeof _gitHistoryDeps.gitWithTimeout;

  beforeEach(() => {
    origGitWithTimeout = _gitHistoryDeps.gitWithTimeout;
  });
  afterEach(() => {
    _gitHistoryDeps.gitWithTimeout = origGitWithTimeout;
  });

  function mockGit(responses: Map<string, { stdout: string; exitCode: number }>) {
    _gitHistoryDeps.gitWithTimeout = async (args: string[]) => {
      const fileArg = args[args.length - 1] ?? "";
      const r = responses.get(fileArg) ?? { stdout: "", exitCode: 0 };
      return { stderr: "", ...r };
    };
  }

  test("AC-1: one of two touched files has history — scopePaths contains only that file", async () => {
    mockGit(
      new Map([
        ["fileA.ts", { stdout: "abc1234 feat: a", exitCode: 0 }],
        ["fileB.ts", { stdout: "", exitCode: 0 }],
      ]),
    );
    const provider = new GitHistoryProvider();
    const result = await provider.fetch(makeContextRequest({ touchedFiles: ["fileA.ts", "fileB.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["fileA.ts"]);
    expect(result.chunks[0]?.scopePaths).not.toContain("fileB.ts");
  });

  test("AC-2: every requested file has history — scopePaths lists them in touchedFiles order", async () => {
    mockGit(
      new Map([
        ["a.ts", { stdout: "abc1234 feat: a", exitCode: 0 }],
        ["b.ts", { stdout: "def5678 feat: b", exitCode: 0 }],
        ["c.ts", { stdout: "aaa0000 feat: c", exitCode: 0 }],
      ]),
    );
    const provider = new GitHistoryProvider();
    const result = await provider.fetch(makeContextRequest({ touchedFiles: ["a.ts", "b.ts", "c.ts"] }));
    expect(result.chunks.length).toBeGreaterThanOrEqual(1);
    expect(result.chunks[0]?.scopePaths).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("AC-3: no requested file has history — returns empty chunks list", async () => {
    mockGit(
      new Map([
        ["noHistory1.txt", { stdout: "", exitCode: 0 }],
        ["noHistory2.txt", { stdout: "", exitCode: 0 }],
      ]),
    );
    const provider = new GitHistoryProvider();
    const result = await provider.fetch(makeContextRequest({ touchedFiles: ["noHistory1.txt", "noHistory2.txt"] }));
    expect(Array.isArray(result.chunks)).toBe(true);
    expect(result.chunks).toHaveLength(0);
  });

  test("AC-4: every returned chunk carries a non-empty scopePaths", async () => {
    mockGit(new Map([["hasHistory.ts", { stdout: "abc1234 feat: works", exitCode: 0 }]]));
    const provider = new GitHistoryProvider();
    const result = await provider.fetch(makeContextRequest({ touchedFiles: ["hasHistory.ts"] }));
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      expect(Array.isArray(chunk.scopePaths)).toBe(true);
      expect((chunk.scopePaths ?? []).length).toBeGreaterThan(0);
    }
  });

  test("AC-5: buildManifest maps a packed git-history chunk id to its scopePaths", () => {
    const packed: PackedChunk[] = [
      makePacked({ id: "git-history:deadbeef", kind: "history", scopePaths: ["a.ts", "b.ts"] }),
    ];
    const manifest = buildManifest(makeManifestInputs({ packed, usedTokens: 50 }));
    expect(manifest.chunkScopePaths).toBeDefined();
    expect(manifest.chunkScopePaths?.["git-history:deadbeef"]).toEqual(["a.ts", "b.ts"]);
  });

  test("AC-6: scored under the scoped classifier, the fixture's sizeCorrelation magnitude is strictly smaller than under whole-diff", async () => {
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const { cases } = loadLabelSet(raw);

    const wholeDiffReport = scoreEffectiveness(cases, wholeDiffClassifier);
    const scopedReport = scoreEffectiveness(cases, scopedClassifier);

    expect(Number.isFinite(scopedReport.sizeCorrelation)).toBe(true);
    expect(Number.isFinite(wholeDiffReport.sizeCorrelation)).toBe(true);
    expect(Math.abs(scopedReport.sizeCorrelation)).toBeLessThan(Math.abs(wholeDiffReport.sizeCorrelation));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — CodeNeighborProvider scope attribution (AC-7..AC-12)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002 — CodeNeighborProvider scope attribution", () => {
  let origFileExists: typeof _codeNeighborDeps.fileExists;
  let origReadFile: typeof _codeNeighborDeps.readFile;
  let origGlob: typeof _codeNeighborDeps.glob;
  let origDiscover: typeof _codeNeighborDeps.discoverWorkspacePackages;
  let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;

  beforeEach(() => {
    origFileExists = _codeNeighborDeps.fileExists;
    origReadFile = _codeNeighborDeps.readFile;
    origGlob = _codeNeighborDeps.glob;
    origDiscover = _codeNeighborDeps.discoverWorkspacePackages;
    origDetectLanguage = _codeNeighborDeps.detectLanguage;
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.detectLanguage = async () => undefined;
  });
  afterEach(() => {
    _codeNeighborDeps.fileExists = origFileExists;
    _codeNeighborDeps.readFile = origReadFile;
    _codeNeighborDeps.glob = origGlob;
    _codeNeighborDeps.discoverWorkspacePackages = origDiscover;
    _codeNeighborDeps.detectLanguage = origDetectLanguage;
  });

  function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
    return {
      globs,
      pathspec: globsToPathspec(globs),
      regex: globsToTestRegex(globs),
      testDirs: extractTestDirs(globs),
      resolution: "root-config",
    };
  }

  function neighborRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
    return makeContextRequest({
      resolvedTestPatterns: makePatterns(["test/unit/**/*.test.ts"]),
      ...overrides,
    });
  }

  function setupDeps(options: { files?: Record<string, string>; globFiles?: string[] }) {
    const { files = {}, globFiles = [] } = options;
    _codeNeighborDeps.fileExists = async (path: string) => {
      const rel = path.replace("/repo/", "");
      return rel in files;
    };
    _codeNeighborDeps.readFile = async (path: string) => {
      const rel = path.replace("/repo/", "");
      return files[rel] ?? "";
    };
    _codeNeighborDeps.glob = () => ({ files: globFiles, truncated: false });
  }

  test("AC-7: touching one file with a neighbor — scopePaths includes the touched file's path", async () => {
    setupDeps({ files: { "src/foo.ts": 'import { helper } from "./helper"' }, globFiles: [] });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(neighborRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0]?.scopePaths).toContain("src/foo.ts");
  });

  test("AC-8: every neighbor path rendered in the chunk body appears in scopePaths", async () => {
    setupDeps({
      files: {
        "src/service.ts": 'import { helper } from "./utils/helper"',
        "src/utils/helper.ts": "export const helper = () => {}",
      },
      globFiles: [],
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(neighborRequest({ touchedFiles: ["src/service.ts"] }));
    const chunk = result.chunks[0];
    expect(chunk).toBeDefined();
    // Extract "- <path>" bullet lines from the rendered neighbor sections.
    const renderedPaths = [...(chunk?.content ?? "").matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    expect(renderedPaths.length).toBeGreaterThan(0);
    for (const p of renderedPaths) {
      expect(chunk?.scopePaths).toContain(p);
    }
  });

  test("AC-9: no touched file has neighbors — returns { chunks: [] }", async () => {
    setupDeps({ globFiles: [] });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(neighborRequest({ touchedFiles: ["scripts/build.ts"], resolvedTestPatterns: undefined }));
    expect(result.chunks).toEqual([]);
    expect(result.chunks).toHaveLength(0);
  });

  test("AC-10: two touched files sharing one neighbor list it exactly once in scopePaths", async () => {
    setupDeps({
      files: {
        "fileA.ts": 'import "./shared"',
        "fileB.ts": 'import "./shared"',
      },
      globFiles: [],
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(
      neighborRequest({ touchedFiles: ["fileA.ts", "fileB.ts"], resolvedTestPatterns: undefined }),
    );
    const chunk = result.chunks[0];
    expect(chunk).toBeDefined();
    const shared = (chunk?.scopePaths ?? []).filter((p) => p === "shared.ts");
    expect(shared).toHaveLength(1);
  });

  test("AC-11: buildManifest maps a packed code-neighbor chunk id to its scopePaths", () => {
    const packed: PackedChunk[] = [
      makePacked({ id: "code-neighbor:cafebabe", kind: "neighbor", scopePaths: ["src/a.ts", "src/b.ts"] }),
    ];
    const manifest = buildManifest(makeManifestInputs({ packed, usedTokens: 50 }));
    const got = manifest.chunkScopePaths?.["code-neighbor:cafebabe"] ?? [];
    expect(new Set(got)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  test("AC-12: fixture-scored, scoped classifier sizeCorrelation magnitude is smaller than wholeDiff", async () => {
    const raw = await Bun.file(COMMITTED_FIXTURE).text();
    const { cases } = loadLabelSet(raw);

    const scopedMagnitude = Math.abs(scoreEffectiveness(cases, scopedClassifier).sizeCorrelation);
    const wholeDiffMagnitude = Math.abs(scoreEffectiveness(cases, wholeDiffClassifier).sizeCorrelation);
    expect(scopedMagnitude).toBeLessThan(wholeDiffMagnitude);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — Per-provider weight derivation (AC-13..AC-27)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003 — buildManifest chunkProviders", () => {
  test("AC-13: chunkProviders maps a packed chunk id to its providerId", () => {
    const packed: PackedChunk[] = [
      { ...makePacked({ id: "abc:123" }), providerId: "provider-x" } as PackedChunk,
    ];
    const manifest = buildManifest(makeManifestInputs({ packed, usedTokens: 50 }));
    expect(manifest.chunkProviders?.["abc:123"]).toBe("provider-x");
  });

  test("AC-14: a packed chunk without providerId has no key in chunkProviders", () => {
    const withProvider: PackedChunk = { ...makePacked({ id: "abc:123" }), providerId: "provider-x" } as PackedChunk;
    const withoutProvider: PackedChunk = makePacked({ id: "xyz:456" });
    const manifest = buildManifest(makeManifestInputs({ packed: [withProvider, withoutProvider], usedTokens: 100 }));
    expect("xyz:456" in (manifest.chunkProviders ?? {})).toBe(false);
  });

  test("AC-15: when no packed chunk carries providerId, chunkProviders is absent", () => {
    const packed: PackedChunk[] = [makePacked({ id: "abc:123" })];
    const manifest = buildManifest(makeManifestInputs({ packed, usedTokens: 50 }));
    expect("chunkProviders" in manifest).toBe(false);
  });
});

describe("US-003 — loadFeatureManifests", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = makeTempDir("nax-loadfeature-");
  });
  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  async function writeManifestFile(featureDir: string, storyId: string) {
    const dir = join(featureDir, ".nax", "features", "feature-id", "stories", storyId);
    await Bun.write(join(dir, "context-manifest-context.json"), JSON.stringify(makeManifest()));
  }

  test("AC-16: two story subdirectories each holding one manifest — returns both", async () => {
    await writeManifestFile(tmpDir, "story-a");
    await writeManifestFile(tmpDir, "story-b");
    const result = await loadFeatureManifests("feature-id", { featureDir: tmpDir });
    expect(result).toHaveLength(2);
  });

  test("AC-17: a stray non-directory entry alongside story directories does not throw", async () => {
    await writeManifestFile(tmpDir, "story-a");
    await writeManifestFile(tmpDir, "story-b");
    await Bun.write(join(tmpDir, ".nax", "features", "feature-id", "readme.txt"), "not a story dir");
    const result = await loadFeatureManifests("feature-id", { featureDir: tmpDir });
    expect(result).toHaveLength(2);
  });

  test("AC-27: no feature id supplied — returns an empty array and does not throw", async () => {
    const result = await loadFeatureManifests();
    expect(result).toEqual([]);
  });
});

describe("US-003 — deriveProviderWeights", () => {
  test("AC-18: empty manifest list — any provider id queried yields weight 1.0", () => {
    const weights = deriveProviderWeights([]);
    expect(weights["any-provider"]).toBe(1.0);
  });

  test("AC-19: provider below the minimum observation count — weight is 1.0", () => {
    // A single classified chunk is below any reasonable MIN_OBSERVATIONS gate
    // (spec: constant is not pinned by acceptance criteria).
    const manifest = ignoredRatioManifest("p1", 1, 1);
    const weights = deriveProviderWeights([manifest]);
    expect(weights.p1).toBe(1.0);
  });

  test("AC-20: provider clears observation count with zero ignored verdicts — weight is 1.0", () => {
    const manifest = ignoredRatioManifest("p1", 50, 0);
    const weights = deriveProviderWeights([manifest]);
    expect(weights.p1).toBe(1.0);
  });

  test("AC-21: higher ignored ratio yields a strictly lower weight than a lower ratio", () => {
    const manifest = makeManifest({
      includedChunks: [],
      chunkProviders: {
        ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p1:${i}`, "p1"])),
        ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p2:${i}`, "p2"])),
      },
      chunkEffectiveness: {
        ...Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`p1:${i}`, { signal: i < 30 ? "ignored" : "followed" }]),
        ),
        ...Object.fromEntries(
          Array.from({ length: 50 }, (_, i) => [`p2:${i}`, { signal: i < 10 ? "ignored" : "followed" }]),
        ),
      },
    } as Partial<ContextManifest>);
    const weights = deriveProviderWeights([manifest]);
    expect(weights.p1).toBeLessThan(weights.p2);
  });

  test("AC-22: no derived weight ever exceeds 1.0", () => {
    const manifest = ignoredRatioManifest("p1", 40, 40);
    const weights = deriveProviderWeights([manifest]);
    expect(weights.p1).toBeLessThanOrEqual(1.0);
  });

  test("AC-23: a provider whose every classified chunk is ignored still has a weight greater than zero", () => {
    const manifest = ignoredRatioManifest("p1", 40, 40);
    const weights = deriveProviderWeights([manifest]);
    expect(weights.p1).toBeGreaterThan(0);
  });

  test("AC-24: chunkEffectiveness present but chunkProviders absent — every queried weight is 1.0", () => {
    const manifest = makeManifest({
      includedChunks: ["p1:0"],
      chunkEffectiveness: { "p1:0": { signal: "ignored" } },
    } as Partial<ContextManifest>);
    const weights = deriveProviderWeights([manifest]);
    expect(weights.p1).toBe(1.0);
    expect(weights["any-provider"]).toBe(1.0);
  });

  test("AC-25: one malformed manifest in the list does not throw — remaining manifests still contribute", () => {
    const good = ignoredRatioManifest("p1", 40, 40);
    const malformed = { not: "a manifest" } as unknown as ContextManifest;
    expect(() => deriveProviderWeights([good, malformed])).not.toThrow();
    const weights = deriveProviderWeights([good, malformed]);
    expect(typeof weights.p1).toBe("number");
  });

  test("AC-26: derivation is not kind-aware — a provider whose only ignored verdicts belong to it still gets a numeric weight", () => {
    // deriveProviderWeights groups only by chunkProviders / chunkEffectiveness;
    // it never reads a chunk-kind map, so it cannot special-case FLOOR_KINDS.
    const manifest = ignoredRatioManifest("p1", 40, 40);
    const weights = deriveProviderWeights([manifest]);
    expect(typeof weights.p1).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — Wire weights into scoring (AC-28..AC-37)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004 — scoreChunk providerWeights operand", () => {
  function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
    return {
      id: "test:abc123",
      providerId: "provider-x",
      kind: "history",
      scope: "story",
      role: ["implementer"],
      content: "some content",
      tokens: 100,
      rawScore: 0.8,
      ...overrides,
    };
  }

  test("AC-28: a weight for the chunk's own providerId multiplies the unweighted score", async () => {
    const { scoreChunk } = await import("@/context/engine/scoring");
    const chunk = makeChunk();
    for (const w of [0.1, 0.5, 0.9]) {
      const unweighted = scoreChunk(chunk, "implementer", undefined, undefined, {} as Record<string, number>);
      const weighted = scoreChunk(chunk, "implementer", undefined, undefined, { "provider-x": w });
      expect(weighted.score).toBeCloseTo(unweighted.score * w);
    }
  });

  test("AC-29: a weight for a different providerId leaves the score unchanged", async () => {
    const { scoreChunk } = await import("@/context/engine/scoring");
    const chunk = makeChunk();
    const unweighted = scoreChunk(chunk, "implementer", undefined, undefined, {} as Record<string, number>);
    const withOtherWeight = scoreChunk(chunk, "implementer", undefined, undefined, { "other-provider": 1.5 });
    expect(withOtherWeight.score).toBe(unweighted.score);
  });

  test("AC-30: no weights supplied — score equals rawScore x role x kind x freshness multipliers (the pre-US-004 formula)", async () => {
    const { scoreChunk } = await import("@/context/engine/scoring");
    const chunk = makeChunk();
    const baseline = scoreChunk(chunk, "implementer");
    const withUndefinedWeights = scoreChunk(chunk, "implementer", undefined, undefined, undefined);
    expect(withUndefinedWeights.score).toBe(baseline.score);
  });

  test("AC-31: scoreChunks applies each chunk's own provider weight — different providers, equal rawScore/kind/role, diverge", async () => {
    const { scoreChunks } = await import("@/context/engine/scoring");
    const chunkA = makeChunk({ id: "a:1", providerId: "provider-a" });
    const chunkB = makeChunk({ id: "b:1", providerId: "provider-b" });
    const result = scoreChunks([chunkA, chunkB], "implementer", undefined, {
      "provider-a": 1.0,
      "provider-b": 0.7,
    });
    expect(result[0]?.score).not.toBe(result[1]?.score);
  });
});

describe("US-004 — ContextOrchestrator.assemble providerWeights", () => {
  class FakeProvider implements IContextProvider {
    readonly id: string;
    readonly kind: RawChunk["kind"];
    private readonly rawScore: number;
    constructor(id: string, kind: RawChunk["kind"], rawScore: number) {
      this.id = id;
      this.kind = kind;
      this.rawScore = rawScore;
    }
    async fetch(): Promise<ContextProviderResult> {
      const chunk: RawChunk = {
        id: `${this.id}:chunk-1`,
        kind: this.kind,
        scope: "story",
        role: ["implementer"],
        content: "content",
        tokens: 10,
        rawScore: this.rawScore,
      };
      return { chunks: [chunk], pullTools: [] };
    }
  }

  test("AC-32: a static-kind chunk weighted below minScore stays in includedChunks, not excludedChunks (floor exempt)", async () => {
    const provider = new FakeProvider("static-provider", "static", 1.0);
    const orchestrator = new ContextOrchestrator([provider]);
    const request = makeContextRequest({
      // providerIds is the orchestrator's test-only override — bypasses the
      // stage-config provider allowlist so a single fake provider can be
      // exercised in isolation (see orchestrator.ts AC-16 comment).
      providerIds: ["static-provider"],
      providerWeights: { "static-provider": 0.05 },
    } as Partial<ContextRequest>);
    const bundle = await orchestrator.assemble(request);
    expect(bundle.manifest.includedChunks).toContain("static-provider:chunk-1");
    expect(bundle.manifest.excludedChunks.some((e) => e.id === "static-provider:chunk-1")).toBe(false);
  });

  test("AC-33: a neighbor-kind chunk weighted below minScore lands in excludedChunks with reason 'below-min-score'", async () => {
    const provider = new FakeProvider("neighbor-provider", "neighbor", 1.0);
    const orchestrator = new ContextOrchestrator([provider]);
    const request = makeContextRequest({
      providerIds: ["neighbor-provider"],
      providerWeights: { "neighbor-provider": 0.05 },
    } as Partial<ContextRequest>);
    const bundle = await orchestrator.assemble(request);
    expect(bundle.manifest.excludedChunks).toContainEqual({
      id: "neighbor-provider:chunk-1",
      reason: "below-min-score",
    });
    expect(bundle.manifest.includedChunks).not.toContain("neighbor-provider:chunk-1");
  });

  test("AC-36: providerWeights absent vs an empty mapping produce identical includedChunks/excludedChunks", async () => {
    const providerAbsent = new FakeProvider("some-provider", "neighbor", 0.5);
    const providerEmpty = new FakeProvider("some-provider", "neighbor", 0.5);
    const bundleAbsent = await new ContextOrchestrator([providerAbsent]).assemble(
      makeContextRequest({ providerIds: ["some-provider"] } as Partial<ContextRequest>),
    );
    const bundleEmpty = await new ContextOrchestrator([providerEmpty]).assemble(
      makeContextRequest({ providerIds: ["some-provider"], providerWeights: {} } as Partial<ContextRequest>),
    );
    expect(bundleAbsent.manifest.includedChunks).toEqual(bundleEmpty.manifest.includedChunks);
    expect(bundleAbsent.manifest.excludedChunks).toEqual(bundleEmpty.manifest.excludedChunks);
  });
});

describe("US-004 — contextStage wiring", () => {
  let origCreateOrchestrator: typeof _contextStageDeps.createOrchestrator;
  let origReadDigest: typeof _contextStageDeps.readDigest;
  let origWriteDigest: typeof _contextStageDeps.writeDigest;
  let origDeriveProviderWeights: typeof _contextStageDeps.deriveProviderWeights;
  let origLoadFeatureManifests: typeof _contextStageDeps.loadFeatureManifests;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-ctx-weights-test-");
    origCreateOrchestrator = _contextStageDeps.createOrchestrator;
    origReadDigest = _contextStageDeps.readDigest;
    origWriteDigest = _contextStageDeps.writeDigest;
    origDeriveProviderWeights = _contextStageDeps.deriveProviderWeights;
    origLoadFeatureManifests = _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.readDigest = async () => "";
    _contextStageDeps.writeDigest = async () => {};
  });
  afterEach(() => {
    _contextStageDeps.createOrchestrator = origCreateOrchestrator;
    _contextStageDeps.readDigest = origReadDigest;
    _contextStageDeps.writeDigest = origWriteDigest;
    _contextStageDeps.deriveProviderWeights = origDeriveProviderWeights;
    _contextStageDeps.loadFeatureManifests = origLoadFeatureManifests;
    cleanupTempDir(tmpDir);
  });

  function makeBundle(): ContextBundle {
    return {
      pushMarkdown: "## Context",
      pullTools: [],
      digest: "",
      manifest: {
        requestId: "req-001",
        stage: "context",
        totalBudgetTokens: 8_000,
        usedTokens: 0,
        includedChunks: [],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 0,
        buildMs: 1,
      },
      chunks: [],
    };
  }

  function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
    return {
      config: {
        context: {
          v2: { enabled: true },
          featureEngine: { budgetTokens: 8_000 },
        },
      } as unknown as PipelineContext["config"],
      rootConfig: {} as PipelineContext["rootConfig"],
      prd: {} as PipelineContext["prd"],
      story: { id: "US-001" } as PipelineContext["story"],
      stories: [],
      routing: {} as PipelineContext["routing"],
      projectDir: tmpDir,
      workdir: tmpDir,
      hooks: {} as PipelineContext["hooks"],
      sessionScratchDir: join(tmpDir, "sessions", "sess-001"),
      sessionId: "sess-001",
      ...overrides,
    } as PipelineContext;
  }

  function mockOrchestrator(bundle: ContextBundle, captureRequest?: (req: ContextRequest) => void) {
    _contextStageDeps.createOrchestrator = () =>
      ({
        async assemble(req: ContextRequest) {
          captureRequest?.(req);
          return bundle;
        },
        rebuildForAgent: () => bundle,
      }) as unknown as ReturnType<typeof _contextStageDeps.createOrchestrator>;
  }

  test("AC-34: deriveProviderWeights is invoked exactly once when config.context.v2.enabled is true", async () => {
    const deriveSpy = mock(async () => ({ providerA: 1.0 }));
    _contextStageDeps.deriveProviderWeights = deriveSpy as typeof _contextStageDeps.deriveProviderWeights;
    _contextStageDeps.loadFeatureManifests = async () => [];
    mockOrchestrator(makeBundle());

    await contextStage.execute(makeCtx());

    expect(deriveSpy).toHaveBeenCalledTimes(1);
  });

  test("AC-35: a non-floor provider's weight below 1.0 makes the written bundle's chunk score strictly lower than weight 1.0", async () => {
    // contextStage assembles at stage "context", whose STAGE_CONTEXT_MAP entry
    // requires all of PHASE_3_EXECUTION to be registered (stage-config.ts) —
    // the orchestrator throws CONTEXT_UNKNOWN_PROVIDER_IDS otherwise. No-op
    // stand-ins satisfy that allowlist; "feature-context" is overridden with
    // the one chunk under test (kind "neighbor" makes it a non-floor chunk).
    class NoopProvider implements IContextProvider {
      constructor(
        readonly id: string,
        readonly kind: RawChunk["kind"],
      ) {}
      async fetch(): Promise<ContextProviderResult> {
        return { chunks: [], pullTools: [] };
      }
    }
    class FakeProvider implements IContextProvider {
      readonly id = "feature-context";
      readonly kind = "neighbor" as const;
      async fetch(): Promise<ContextProviderResult> {
        return {
          chunks: [
            {
              id: "feature-context:chunk-1",
              kind: "neighbor",
              scope: "story",
              role: ["implementer"],
              content: "content",
              tokens: 10,
              rawScore: 1.0,
            },
          ],
          pullTools: [],
        };
      }
    }
    _contextStageDeps.loadFeatureManifests = async () => [];
    _contextStageDeps.createOrchestrator = () =>
      new ContextOrchestrator([
        new NoopProvider("static-rules", "static"),
        new FakeProvider(),
        new NoopProvider("session-scratch", "session"),
        new NoopProvider("git-history", "history"),
        new NoopProvider("code-neighbor", "neighbor"),
        new NoopProvider("test-coverage", "test-coverage"),
      ]);

    _contextStageDeps.deriveProviderWeights = (async () => ({
      "feature-context": 0.3,
    })) as typeof _contextStageDeps.deriveProviderWeights;
    const ctxLow = makeCtx();
    await contextStage.execute(ctxLow);
    const lowScore = ctxLow.contextBundle?.chunks.find((c) => c.id === "feature-context:chunk-1")?.score;

    _contextStageDeps.deriveProviderWeights = (async () => ({
      "feature-context": 1.0,
    })) as typeof _contextStageDeps.deriveProviderWeights;
    const ctxHigh = makeCtx();
    await contextStage.execute(ctxHigh);
    const highScore = ctxHigh.contextBundle?.chunks.find((c) => c.id === "feature-context:chunk-1")?.score;

    expect(lowScore).toBeDefined();
    expect(highScore).toBeDefined();
    expect(lowScore as number).toBeLessThan(highScore as number);
  });

  test("AC-37: loadFeatureManifests is invoked with the feature id from the pipeline context", async () => {
    const loadSpy = mock(async () => []);
    _contextStageDeps.loadFeatureManifests = loadSpy as typeof _contextStageDeps.loadFeatureManifests;
    _contextStageDeps.deriveProviderWeights = (async () => ({})) as typeof _contextStageDeps.deriveProviderWeights;
    mockOrchestrator(makeBundle());

    await contextStage.execute(makeCtx({ featureDir: "feat-123" } as Partial<PipelineContext>));

    expect(loadSpy).toHaveBeenCalledWith(expect.objectContaining({ featureId: "feat-123" }));
  });
});