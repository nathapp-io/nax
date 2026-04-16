import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { FeatureContextProviderV2, _featureContextV2Deps } from "../../../../../src/context/v2/providers/feature-context";
import type { ContextRequest } from "../../../../../src/context/v2/types";
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
    workdir: "/repo",
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
