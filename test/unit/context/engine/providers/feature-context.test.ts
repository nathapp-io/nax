import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FeatureContextProviderV2, _featureContextV2Deps } from "../../../../../src/context/engine/providers/feature-context";
import type { ContextRequest } from "../../../../../src/context/engine/types";
import type { NaxConfig } from "../../../../../src/config/types";
import type { UserStory } from "../../../../../src/prd";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STORY: UserStory = {
  id: "story-001",
  title: "Test story",
  description: "",
  acceptanceCriteria: [],
  status: "pending",
} as unknown as UserStory;

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
    return {
      context: { v2: { staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 } } },
    } as unknown as NaxConfig;
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
