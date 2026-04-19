import { describe, expect, test } from "bun:test";

type PartialConfig = {
  agent?: { fallback?: { enabled?: boolean; map?: Record<string, string[]>; maxHopsPerStory?: number; onQualityFailure?: boolean } };
};

// ADR-012 Phase 5: context.v2.fallback removed. agent.fallback is the sole source.
describe("execution stage fallback config resolution", () => {
  test("agent.fallback is used when present", () => {
    const config: PartialConfig = {
      agent: { fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false } },
    };
    const resolved = config.agent?.fallback;
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.maxHopsPerStory).toBe(2);
  });

  test("agent.fallback is undefined when not configured — swap is disabled", () => {
    const config: PartialConfig = {
      agent: {},
    };
    const resolved = config.agent?.fallback;
    expect(resolved).toBeUndefined();
  });

  test("agent.fallback respects enabled:false — swap disabled even with map", () => {
    const config: PartialConfig = {
      agent: { fallback: { enabled: false, map: { claude: ["codex"] }, maxHopsPerStory: 1, onQualityFailure: false } },
    };
    const resolved = config.agent?.fallback;
    expect(resolved?.enabled).toBe(false);
    expect(resolved?.maxHopsPerStory).toBe(1);
  });
});
