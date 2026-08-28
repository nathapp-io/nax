/**
 * US-003 — Dependency-scoped fragment reads with distance decay.
 *
 * These tests pin the read path: FeatureContextProviderV2.fetch() walks the
 * feature's PRD dependency graph from the requesting story, reads each
 * reached story's fragment file, and emits one RawChunk per reached story
 * with rawScore = decay ** dependencyDistance.
 *
 * Mocking strategy — all external I/O flows through `_featureContextV2Deps`
 * (see src/context/engine/providers/feature-context.ts):
 *   - createV1Provider: v1 context.md path (kept for context.md continuity)
 *   - loadPRD:          reads <repoRoot>/.nax/features/<featureId>/prd.json
 *   - readFragment:     reads <projectDir>/.nax/features/<featureId>/fragments/<storyId>.md
 *   - listFragmentStoryIds: returns the set of stories that have fragments
 *
 * No real disk I/O is performed. v1 is mocked to keep its chunks easy to
 * distinguish from the new fragment chunks (different id prefix).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { NaxConfig } from "@/config/types";
import { _featureContextV2Deps, FeatureContextProviderV2 } from "@/context/engine";
import type { ContextRequest, RawChunk } from "@/context/engine/types";
import type { PRD, UserStory } from "@/prd";
import { byCodePoint } from "@/utils/sort";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap `helpers.makeStory` with an explicit (id, deps) positional form. */
function storyWith(id: string, dependencies: readonly string[] = []): UserStory {
  return makeStory({ id, dependencies: [...dependencies] });
}

function prdWith(stories: readonly UserStory[], featureId = "TEST-FEATURE"): PRD {
  return makePRD({ feature: featureId, userStories: stories as UserStory[] });
}

function makeFragmentsConfig(overrides: { decay?: number; maxTokens?: number; enabled?: boolean } = {}): NaxConfig {
  return makeNaxConfig({
    context: {
      v2: {
        fragments: {
          enabled: overrides.enabled ?? true,
          decay: overrides.decay ?? 0.6,
          maxTokens: overrides.maxTokens ?? 400,
          extractor: "deterministic",
        },
      },
    },
  });
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    featureId: "TEST-FEATURE",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

/** Filter returned chunks into "fragment" chunks (US-003) vs the legacy context.md chunks. */
function fragmentChunks(chunks: RawChunk[]): RawChunk[] {
  return chunks.filter((c) => c.id.startsWith("feature-fragment:"));
}

function contextMdChunks(chunks: RawChunk[]): RawChunk[] {
  return chunks.filter((c) => c.id.startsWith("feature-context:"));
}

// ─────────────────────────────────────────────────────────────────────────────
// _deps save / restore
// ─────────────────────────────────────────────────────────────────────────────

type DepsShape = typeof _featureContextV2Deps;
let origDeps: DepsShape;

beforeEach(() => {
  origDeps = {
    createV1Provider: _featureContextV2Deps.createV1Provider,
    loadPRD: _featureContextV2Deps.loadPRD,
    readFragment: _featureContextV2Deps.readFragment,
    listFragmentStoryIds: _featureContextV2Deps.listFragmentStoryIds,
  };
});

afterEach(() => {
  _featureContextV2Deps.createV1Provider = origDeps.createV1Provider;
  _featureContextV2Deps.loadPRD = origDeps.loadPRD;
  _featureContextV2Deps.readFragment = origDeps.readFragment;
  _featureContextV2Deps.listFragmentStoryIds = origDeps.listFragmentStoryIds;
});

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

function mockV1Empty(): void {
  _featureContextV2Deps.createV1Provider = (() =>
    ({
      getContext: async () => null,
    }) as ReturnType<DepsShape["createV1Provider"]>) as DepsShape["createV1Provider"];
}

function mockV1WithContextMd(content = "## Pre-existing context\n\nold notes"): void {
  _featureContextV2Deps.createV1Provider = () => ({
    getContext: async () => ({
      content,
      estimatedTokens: 50,
      label: "feature-context",
      featureId: "TEST-FEATURE",
    }),
  });
}

function mockLoadPRD(prd: PRD | null): void {
  _featureContextV2Deps.loadPRD = (async () => prd) as DepsShape["loadPRD"];
}

function mockReadFragment(bodies: Readonly<Record<string, string>>): void {
  _featureContextV2Deps.readFragment = ((_p: string, _f: string, storyId: string) =>
    Promise.resolve(bodies[storyId] ?? null)) as DepsShape["readFragment"];
}

function mockListFragmentStoryIds(storyIds: readonly string[]): void {
  _featureContextV2Deps.listFragmentStoryIds = ((_p: string, _f: string) =>
    Promise.resolve([...storyIds])) as DepsShape["listFragmentStoryIds"];
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: requesting story with no dependencies → no fragment chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("FeatureContextProviderV2 US-003 — fragment dependency walk", () => {
  test("AC1: story with empty dependencies returns no fragment-identifying chunks", async () => {
    mockV1Empty();
    mockLoadPRD(prdWith([storyWith("US-001")]));
    mockListFragmentStoryIds([]);
    mockReadFragment({});

    const story = storyWith("US-001");
    const provider = new FeatureContextProviderV2(story, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    expect(fragmentChunks(result.chunks)).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC2: direct dep with fragment → 1 fragment chunk identifying the dep
  // ─────────────────────────────────────────────────────────────────────────

  test("AC2: direct dependency with fragment emits one chunk identifying that dep", async () => {
    mockV1Empty();
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002");
    mockLoadPRD(prdWith([a, b]));
    mockListFragmentStoryIds(["US-002"]);
    mockReadFragment({ "US-002": "# US-002 fragment body\n" });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe("feature-fragment:US-002");
    expect(f[0]?.content).toBe("# US-002 fragment body\n");
    expect(f[0]?.tokens).toBe(Math.ceil("# US-002 fragment body\n".length / 4));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC3: 3-story chain → chunks for B & C, none for A (the requesting story)
  // ─────────────────────────────────────────────────────────────────────────

  test("AC3: 3-story chain emits chunks for the dep and transitive dep, none for requesting story", async () => {
    mockV1Empty();
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002", ["US-003"]);
    const c = storyWith("US-003");
    mockLoadPRD(prdWith([a, b, c]));
    mockListFragmentStoryIds(["US-002", "US-003"]);
    mockReadFragment({
      "US-002": "b-body",
      "US-003": "c-body",
    });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    const ids = f.map((chunk) => chunk.id).sort(byCodePoint);
    expect(ids).toEqual(["feature-fragment:US-002", "feature-fragment:US-003"]);
    expect(f.some((chunk) => chunk.id === "feature-fragment:US-001")).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC4: 2-hop chain, third story score strictly lower than second's
  // ─────────────────────────────────────────────────────────────────────────

  test("AC4: 2-hop chain: 3rd-story chunk has strictly lower score than 2nd-story chunk", async () => {
    mockV1Empty();
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002", ["US-003"]);
    const c = storyWith("US-003");
    mockLoadPRD(prdWith([a, b, c]));
    mockListFragmentStoryIds(["US-002", "US-003"]);
    mockReadFragment({
      "US-002": "b-body",
      "US-003": "c-body",
    });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig({ decay: 0.6 }));
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    const bChunk = f.find((chunk) => chunk.id === "feature-fragment:US-002");
    const cChunk = f.find((chunk) => chunk.id === "feature-fragment:US-003");
    assertDefined(bChunk, "US-002 fragment chunk");
    assertDefined(cChunk, "US-003 fragment chunk");
    expect(bChunk.rawScore).toBeCloseTo(0.6, 5);
    expect(cChunk.rawScore).toBeCloseTo(0.36, 5);
    expect(cChunk.rawScore).toBeLessThan(bChunk.rawScore);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC5: diamond — same story reached by 2 paths → exactly one chunk, shorter distance
  // ─────────────────────────────────────────────────────────────────────────

  test("AC5: diamond — story reached by 2 paths emits exactly one chunk at the shorter distance", async () => {
    mockV1Empty();
    // A → {B, C}; B → D; C → D (diamond — D reached via 2 paths, both at distance 2)
    // To exercise the shorter-distance rule, set up B → D and C → D where C also
    // has another short path to E and E → D. Concretely: A → B; A → C; A → E;
    // B → D; C → D; E → D. So D is reached at distance 2 via B, 2 via C, 2 via E.
    // To get a strict shorter-distance pair, give D a longer path through B:
    // A → X; X → B; A → C; C → D; B → D. Now D is at distance 2 via C and 3 via B.
    const a = storyWith("US-001", ["US-X", "US-C"]);
    const x = storyWith("US-X", ["US-B"]);
    const c = storyWith("US-C", ["US-D"]);
    const b = storyWith("US-B", ["US-D"]);
    const d = storyWith("US-D");
    mockLoadPRD(prdWith([a, x, c, b, d]));
    mockListFragmentStoryIds(["US-D"]);
    mockReadFragment({ "US-D": "d-body" });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig({ decay: 0.6 }));
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    expect(f).toHaveLength(1);
    const dChunk = f[0];
    expect(dChunk.id).toBe("feature-fragment:US-D");
    // D via C: A → C → D = distance 2 (shorter); via B: A → X → B → D = distance 3.
    // rawScore = decay^2 = 0.36.
    expect(dChunk.rawScore).toBeCloseTo(0.36, 5);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC6: cycle → returns without raising, at most one chunk per story
  // ─────────────────────────────────────────────────────────────────────────

  test("AC6: cycle returns without raising and emits at most one chunk per story", async () => {
    mockV1Empty();
    // US-001 → US-002 → US-001 (cycle), both have fragments
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002", ["US-001"]);
    mockLoadPRD(prdWith([a, b]));
    mockListFragmentStoryIds(["US-002"]);
    mockReadFragment({ "US-002": "b-body" });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    let result: Awaited<ReturnType<typeof provider.fetch>> | undefined;
    let raised: unknown = null;
    try {
      result = await provider.fetch(makeRequest({ storyId: "US-001" }));
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeNull();
    assertDefined(result, "fetch result after cycle walk");
    const f = fragmentChunks(result.chunks);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe("feature-fragment:US-002");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC7: rawScore = decay ** distance with base score 1.0
  // ─────────────────────────────────────────────────────────────────────────

  test("AC7: rawScore equals decay^d with base score 1.0 at distance 1, 2, 3", async () => {
    mockV1Empty();
    // A → B → C → D; all four have fragments
    const a = storyWith("US-001", ["US-B"]);
    const b = storyWith("US-B", ["US-C"]);
    const c = storyWith("US-C", ["US-D"]);
    const d = storyWith("US-D");
    mockLoadPRD(prdWith([a, b, c, d]));
    mockListFragmentStoryIds(["US-B", "US-C", "US-D"]);
    mockReadFragment({
      "US-B": "b",
      "US-C": "c",
      "US-D": "d",
    });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig({ decay: 0.6 }));
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    expect(f).toHaveLength(3);
    const bChunk = f.find((chunk) => chunk.id === "feature-fragment:US-B");
    const cChunk = f.find((chunk) => chunk.id === "feature-fragment:US-C");
    const dChunk = f.find((chunk) => chunk.id === "feature-fragment:US-D");
    assertDefined(bChunk, "US-B fragment chunk");
    assertDefined(cChunk, "US-C fragment chunk");
    assertDefined(dChunk, "US-D fragment chunk");
    // distance 1: 0.6^1 = 0.6
    expect(bChunk.rawScore).toBeCloseTo(0.6, 5);
    // distance 2: 0.6^2 = 0.36
    expect(cChunk.rawScore).toBeCloseTo(0.36, 5);
    // distance 3: 0.6^3 = 0.216
    expect(dChunk.rawScore).toBeCloseTo(0.216, 5);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC8: story with no fragment contributes no chunk, but its deps still emit
  // ─────────────────────────────────────────────────────────────────────────

  test("AC8: story with no fragment contributes no chunk; its deps still contribute chunks", async () => {
    mockV1Empty();
    // A → B; B has no fragment; B → C; C has a fragment
    const a = storyWith("US-001", ["US-B"]);
    const b = storyWith("US-B", ["US-C"]);
    const c = storyWith("US-C");
    mockLoadPRD(prdWith([a, b, c]));
    mockListFragmentStoryIds(["US-C"]);
    mockReadFragment({ "US-C": "c-body" });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    expect(f).toHaveLength(1);
    expect(f[0]?.id).toBe("feature-fragment:US-C");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC9: missing prd.json → no fragment chunks, context.md chunk still returned
  // ─────────────────────────────────────────────────────────────────────────

  test("AC9: missing prd.json returns no fragment chunks but still returns the context.md chunk", async () => {
    mockV1WithContextMd("# existing context");
    mockLoadPRD(null);
    mockListFragmentStoryIds(["US-002"]);
    mockReadFragment({ "US-002": "b-body" });

    const story = storyWith("US-001", ["US-002"]);
    const provider = new FeatureContextProviderV2(story, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    expect(fragmentChunks(result.chunks)).toHaveLength(0);
    const mdChunks = contextMdChunks(result.chunks);
    expect(mdChunks.length).toBeGreaterThanOrEqual(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC10: fragments.enabled = false → no fragment chunks even when files exist
  // ─────────────────────────────────────────────────────────────────────────

  test("AC10: fragments.enabled = false suppresses fragment chunks even when fragments exist", async () => {
    mockV1Empty();
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002");
    mockLoadPRD(prdWith([a, b]));
    mockListFragmentStoryIds(["US-002"]);
    mockReadFragment({ "US-002": "b-body" });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig({ enabled: false }));
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    expect(fragmentChunks(result.chunks)).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC11: fragment chunks carry kind = "feature"
  // ─────────────────────────────────────────────────────────────────────────

  test("AC11: fragment chunks carry kind 'feature'", async () => {
    mockV1Empty();
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002");
    mockLoadPRD(prdWith([a, b]));
    mockListFragmentStoryIds(["US-002"]);
    mockReadFragment({ "US-002": "b-body" });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const f = fragmentChunks(result.chunks);
    expect(f).toHaveLength(1);
    expect(f[0]?.kind).toBe("feature");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Sanity: requesting story never contributes its own fragment
  // ─────────────────────────────────────────────────────────────────────────

  test("sanity: requesting story is never emitted as its own fragment", async () => {
    mockV1Empty();
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002");
    mockLoadPRD(prdWith([a, b]));
    mockListFragmentStoryIds(["US-001", "US-002"]);
    mockReadFragment({
      "US-001": "a-body",
      "US-002": "b-body",
    });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const ids = fragmentChunks(result.chunks).map((chunk) => chunk.id);
    expect(ids).toContain("feature-fragment:US-002");
    expect(ids).not.toContain("feature-fragment:US-001");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Regression: a cycle back to the requesting story must not re-emit it.
  // Walking A → B → A would otherwise put A in the reached set at distance 2
  // and emit A's own fragment back to A — which violates AC3 ("none for the
  // requesting story itself").
  // ─────────────────────────────────────────────────────────────────────────

  test("regression: cycle back to requesting story does not re-emit its own fragment", async () => {
    mockV1Empty();
    // A → B; B → A. A (the requesting story) has a fragment on disk.
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002", ["US-001"]);
    mockLoadPRD(prdWith([a, b]));
    mockListFragmentStoryIds(["US-001", "US-002"]);
    mockReadFragment({
      "US-001": "a-body",
      "US-002": "b-body",
    });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const ids = fragmentChunks(result.chunks)
      .map((chunk) => chunk.id)
      .sort(byCodePoint);
    expect(ids).toEqual(["feature-fragment:US-002"]);
  });

  test("regression: 3-cycle through the requesting story does not re-emit it", async () => {
    mockV1Empty();
    // A → B → C → A. A (the requesting story) has a fragment.
    const a = storyWith("US-001", ["US-002"]);
    const b = storyWith("US-002", ["US-003"]);
    const c = storyWith("US-003", ["US-001"]);
    mockLoadPRD(prdWith([a, b, c]));
    mockListFragmentStoryIds(["US-001", "US-002", "US-003"]);
    mockReadFragment({
      "US-001": "a-body",
      "US-002": "b-body",
      "US-003": "c-body",
    });

    const provider = new FeatureContextProviderV2(a, makeFragmentsConfig());
    const result = await provider.fetch(makeRequest({ storyId: "US-001" }));

    const ids = fragmentChunks(result.chunks)
      .map((chunk) => chunk.id)
      .sort(byCodePoint);
    expect(ids).toEqual(["feature-fragment:US-002", "feature-fragment:US-003"]);
  });
});
