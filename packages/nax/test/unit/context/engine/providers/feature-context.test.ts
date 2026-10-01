import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeNaxConfig, makePRD, makeStory, makeTempDir } from "@test/helpers";
import type { NaxConfig } from "@/config/types";
import { _featureContextV2Deps, FeatureContextProviderV2 } from "@/context/engine/providers/feature-context";
import type { ContextRequest, RawChunk } from "@/context/engine/types";
import { renderFragmentBody, writeFragment } from "@/context/fragments";
import type { UserStory } from "@/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STORY: UserStory = makeStory({
  id: "story-001",
  title: "Test story",
  description: "",
});

const CONFIG = {} as NaxConfig;

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "story-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock v1 provider factory
// ─────────────────────────────────────────────────────────────────────────────

type V1ProviderResult = {
  content: string;
  estimatedTokens: number;
  featureId?: string;
} | null;

let origCreateV1Provider: typeof _featureContextV2Deps.createV1Provider;

function mockV1Provider(result: V1ProviderResult) {
  _featureContextV2Deps.createV1Provider = () =>
    ({
      getContext: async () => result,
    }) as ReturnType<typeof _featureContextV2Deps.createV1Provider>;
}

beforeEach(() => {
  origCreateV1Provider = _featureContextV2Deps.createV1Provider;
});

afterEach(() => {
  _featureContextV2Deps.createV1Provider = origCreateV1Provider;
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("FeatureContextProviderV2", () => {
  test("id and kind are correct", () => {
    const provider = new FeatureContextProviderV2(STORY, CONFIG);
    expect(provider.id).toBe("feature-context");
    expect(provider.kind).toBe("feature");
  });

  test("returns a feature chunk when v1 returns content", async () => {
    mockV1Provider({ content: "# Feature context", estimatedTokens: 50, featureId: "my-feature" });
    const provider = new FeatureContextProviderV2(STORY, CONFIG);
    const result = await provider.fetch(makeRequest());

    expect(result.chunks).toHaveLength(1);
    const chunk = result.chunks[0];
    expect(chunk.kind).toBe("feature");
    expect(chunk.scope).toBe("feature");
    expect(chunk.role).toContain("implementer");
    expect(chunk.role).toContain("reviewer");
    expect(chunk.role).toContain("tdd");
    expect(chunk.rawScore).toBe(1.0);
    expect(chunk.content).toBe("# Feature context");
    expect(chunk.tokens).toBe(50);
    expect(chunk.id).toMatch(/^feature-context:[0-9a-f]{8}$/);
    expect(result.pullTools).toEqual([]);
  });

  test("returns empty chunks when v1 returns null", async () => {
    mockV1Provider(null);
    const provider = new FeatureContextProviderV2(STORY, CONFIG);
    const result = await provider.fetch(makeRequest());

    expect(result.chunks).toHaveLength(0);
    expect(result.pullTools).toEqual([]);
  });

  test("chunk id is stable for identical content (deterministic hash)", async () => {
    const content = "Same content";
    mockV1Provider({ content, estimatedTokens: 10 });
    const provider = new FeatureContextProviderV2(STORY, CONFIG);

    const r1 = await provider.fetch(makeRequest());
    const r2 = await provider.fetch(makeRequest());
    expect(r1.chunks[0].id).toBe(r2.chunks[0].id);
  });

  test("chunk id differs for different content", async () => {
    const provider = new FeatureContextProviderV2(STORY, CONFIG);

    mockV1Provider({ content: "Content A", estimatedTokens: 10 });
    const r1 = await provider.fetch(makeRequest());

    mockV1Provider({ content: "Content B", estimatedTokens: 10 });
    const r2 = await provider.fetch(makeRequest());

    expect(r1.chunks[0].id).not.toBe(r2.chunks[0].id);
  });

  test("returns empty chunks on v1 provider error (soft failure)", async () => {
    _featureContextV2Deps.createV1Provider = () =>
      ({
        getContext: async () => {
          throw new Error("disk read error");
        },
      }) as ReturnType<typeof _featureContextV2Deps.createV1Provider>;

    const provider = new FeatureContextProviderV2(STORY, CONFIG);
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M6: AC-46 per-entry staleness scoring
// ─────────────────────────────────────────────────────────────────────────────

describe("FeatureContextProviderV2 — #508-M6 per-entry staleness scoring", () => {
  // Content: 2 entries in same section. Entry 0 is contradicted by entry 1
  // (shares >= 3 significant terms, entry 1 has negation "no longer").
  // Stale entries: 1 of 2 → ratio = 0.5
  // Effective multiplier: 1.0 - (1.0 - 0.4) * 0.5 = 0.7
  const PARTIAL_STALE_CONTENT = [
    "## Authentication",
    "",
    "The service fetches data from postgres database using active connections.",
    "",
    "The service no longer fetches data from postgres database — removed active connections.",
  ].join("\n");

  // Plain content — no stale entries
  const NO_STALE_CONTENT = "## Summary\n\nThe project is a standard TypeScript CLI.";

  function makeStaleConfig(): NaxConfig {
    return makeNaxConfig({
      context: { v2: { staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 } } },
    });
  }

  test("chunk has no scoreMultiplier when no entries are stale", async () => {
    mockV1Provider({ content: NO_STALE_CONTENT, estimatedTokens: 20 });
    const provider = new FeatureContextProviderV2(STORY, makeStaleConfig());
    const result = await provider.fetch(makeRequest());

    const chunk = result.chunks[0];
    expect(chunk).toBeDefined();
    expect(chunk.scoreMultiplier).toBeUndefined();
    expect(chunk.staleCandidate).toBeFalsy();
  });

  test("only stale entry chunks get scoreMultiplier when one of two entries is contradicted", async () => {
    // 2 entries in same section. Entry 0 is contradicted by entry 1
    // (shares 7 significant terms, entry 1 has "no longer" negation).
    // stale count = 1, total = 2, ratio = 0.5
    // effective multiplier = 1.0 - (1.0 - 0.4) * 0.5 = 0.7
    mockV1Provider({ content: PARTIAL_STALE_CONTENT, estimatedTokens: 30 });
    const provider = new FeatureContextProviderV2(STORY, makeStaleConfig());
    const result = await provider.fetch(makeRequest());

    expect(result.chunks).toHaveLength(2);
    const staleChunks = result.chunks.filter((c) => c.staleCandidate);
    const freshChunks = result.chunks.filter((c) => !c.staleCandidate);
    expect(staleChunks).toHaveLength(1);
    expect(freshChunks).toHaveLength(1);
    expect(staleChunks[0]?.scoreMultiplier).toBeCloseTo(0.4, 5);
    expect(freshChunks[0]?.scoreMultiplier).toBeUndefined();
  });

  test("entry chunk IDs are deterministic and indexed", async () => {
    mockV1Provider({ content: PARTIAL_STALE_CONTENT, estimatedTokens: 30 });
    const provider = new FeatureContextProviderV2(STORY, makeStaleConfig());
    const r1 = await provider.fetch(makeRequest());
    const r2 = await provider.fetch(makeRequest());
    expect(r1.chunks.map((c) => c.id)).toEqual(r2.chunks.map((c) => c.id));
    expect(r1.chunks[0]?.id).toMatch(/:entry-0$/);
    expect(r1.chunks[1]?.id).toMatch(/:entry-1$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fragment read-back — real-filesystem behaviour
//
// The sibling `feature-context-fragments.test.ts` stubs `readFragment` and
// `listFragmentStoryIds`, and its stubs ignore the `projectDir` argument
// entirely. That is why the read path could ship broken: the provider passed
// `${repoRoot}/.nax` as the store's `projectDir`, but the store owns the
// `.nax` segment itself (`fragmentPath` -> `featureDir` -> `featuresDir`), so
// every read resolved to `<repoRoot>/.nax/.nax/features/...` and found
// nothing. Capture and read were tested on opposite sides of a stub, so the
// path contract between them was untested by construction.
//
// These tests therefore write fragments with the REAL `writeFragment` and read
// them back through the REAL provider against a REAL temp directory. Only
// `createV1Provider` is stubbed, to keep the legacy context.md path out of the
// assertions. Do not stub the fragment store here — that would reintroduce the
// blind spot this file exists to cover.
// ─────────────────────────────────────────────────────────────────────────────

describe("FeatureContextProviderV2 fragment read-back (real fs)", () => {
  const FEATURE_ID = "feat-readback";
  const FRAGMENT_MAX_TOKENS = 400;

  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempDir();
    // The legacy context.md path is irrelevant here and would otherwise touch
    // disk; every assertion below filters on the `feature-fragment:` prefix.
    mockV1Provider(null);
  });

  afterEach(() => {
    cleanupTempDir(repoRoot);
  });

  function makeFragmentsConfig(overrides: { decay?: number; enabled?: boolean } = {}): NaxConfig {
    return makeNaxConfig({
      context: {
        v2: {
          fragments: {
            enabled: overrides.enabled ?? true,
            decay: overrides.decay ?? 0.6,
            maxTokens: FRAGMENT_MAX_TOKENS,
            extractor: "deterministic",
          },
        },
      },
    });
  }

  function storyWith(id: string, dependencies: readonly string[] = []): UserStory {
    return makeStory({ id, dependencies: [...dependencies] });
  }

  /** Write a real prd.json where the provider's `featurePrdPath` expects it. */
  async function writePRD(stories: readonly UserStory[]): Promise<void> {
    const dir = join(repoRoot, ".nax", "features", FEATURE_ID);
    await mkdir(dir, { recursive: true });
    const prd = makePRD({ feature: FEATURE_ID, userStories: stories as UserStory[] });
    await writeFile(join(dir, "prd.json"), JSON.stringify(prd, null, 2), "utf-8");
  }

  function makeReadbackRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
    return {
      storyId: "US-002",
      featureId: FEATURE_ID,
      repoRoot,
      packageDir: repoRoot,
      stage: "execution",
      role: "implementer",
      budgetTokens: 8_000,
      ...overrides,
    };
  }

  function fragmentChunks(chunks: RawChunk[]): RawChunk[] {
    return chunks.filter((c) => c.id.startsWith("feature-fragment:"));
  }

  test("reads back a fragment written by the real capture path", async () => {
    // Capture exactly as completionStage does: projectDir is the repo root,
    // and the store appends the `.nax/features/<id>/fragments` segments.
    const body = renderFragmentBody(
      "US-001",
      "Resolve profile contestants",
      ["Given a profile name, when resolved, then the overlay is merged"],
      ["src/bakeoff/preflight.ts"],
    );
    await writeFragment(repoRoot, FEATURE_ID, "US-001", body, FRAGMENT_MAX_TOKENS);
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-002", ["US-001"]), makeFragmentsConfig());
    const result = await provider.fetch(makeReadbackRequest());

    const fragments = fragmentChunks(result.chunks);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.id).toBe("feature-fragment:US-001");
    expect(fragments[0]?.content).toContain("src/bakeoff/preflight.ts");
  });

  test("scores a transitive dependency by distance", async () => {
    for (const id of ["US-001", "US-002"]) {
      await writeFragment(
        repoRoot,
        FEATURE_ID,
        id,
        renderFragmentBody(id, `story ${id}`, ["ac"], [`src/${id}.ts`]),
        FRAGMENT_MAX_TOKENS,
      );
    }
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"]), storyWith("US-003", ["US-002"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-003", ["US-002"]), makeFragmentsConfig({ decay: 0.5 }));
    const result = await provider.fetch(makeReadbackRequest({ storyId: "US-003" }));

    const byId = new Map(fragmentChunks(result.chunks).map((c) => [c.id, c]));
    expect(byId.get("feature-fragment:US-002")?.rawScore).toBeCloseTo(0.5, 10);
    expect(byId.get("feature-fragment:US-001")?.rawScore).toBeCloseTo(0.25, 10);
  });

  test("bounds the fragment set by token budget, keeping the nearest dependencies", async () => {
    // Fragments are floor-kind, so nothing downstream can drop them; the
    // provider's own bound is the only thing between a long dependency chain
    // and an unmetered injection. A 2_000-token stage yields a 400-token
    // fragment budget, so only the two nearest of four ~143-token fragments
    // survive (2 x 143 = 286 fits; a third would reach 429).
    const filler = "src/some/module/with/a/reasonably/long/path.ts";
    const chain = ["US-001", "US-002", "US-003", "US-004"];
    for (const id of chain) {
      await writeFragment(
        repoRoot,
        FEATURE_ID,
        id,
        renderFragmentBody(
          id,
          `story ${id}`,
          [`ac for ${id}`],
          Array.from({ length: 10 }, () => filler),
        ),
        FRAGMENT_MAX_TOKENS,
      );
    }
    await writePRD([
      storyWith("US-001"),
      storyWith("US-002", ["US-001"]),
      storyWith("US-003", ["US-002"]),
      storyWith("US-004", ["US-003"]),
      storyWith("US-005", ["US-004"]),
    ]);

    const provider = new FeatureContextProviderV2(storyWith("US-005", ["US-004"]), makeFragmentsConfig());
    const result = await provider.fetch(makeReadbackRequest({ storyId: "US-005", budgetTokens: 2_000 }));

    const fragments = fragmentChunks(result.chunks);
    const totalTokens = fragments.reduce((sum, c) => sum + c.tokens, 0);

    expect(fragments.map((c) => c.id)).toEqual(["feature-fragment:US-004", "feature-fragment:US-003"]);
    expect(totalTokens).toBeLessThanOrEqual(400);
  });

  test("never drops the nearest fragment, even when the stage budget is tiny", async () => {
    // Guards the `Math.max(maxTokens, share)` floor: a small budget must
    // degrade to "nearest only", never to silently nothing.
    await writeFragment(
      repoRoot,
      FEATURE_ID,
      "US-001",
      renderFragmentBody("US-001", "story US-001", ["ac"], ["src/a.ts"]),
      FRAGMENT_MAX_TOKENS,
    );
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-002", ["US-001"]), makeFragmentsConfig());
    const result = await provider.fetch(makeReadbackRequest({ budgetTokens: 10 }));

    expect(fragmentChunks(result.chunks).map((c) => c.id)).toEqual(["feature-fragment:US-001"]);
  });

  test("emits nothing when the feature has no fragments on disk", async () => {
    await writePRD([storyWith("US-001"), storyWith("US-002", ["US-001"])]);

    const provider = new FeatureContextProviderV2(storyWith("US-002", ["US-001"]), makeFragmentsConfig());
    const result = await provider.fetch(makeReadbackRequest());

    expect(fragmentChunks(result.chunks)).toHaveLength(0);
  });
});
