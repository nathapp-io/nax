import { describe, expect, test } from "bun:test";

type PartialConfig = {
  agent?: { fallback?: { enabled?: boolean; map?: Record<string, string[]>; maxHopsPerStory?: number; onQualityFailure?: boolean } };
  context?: { v2?: { fallback?: { enabled?: boolean; map?: Record<string, string[]>; maxHopsPerStory?: number; onQualityFailure?: boolean } } };
};

describe("execution stage fallback config resolution", () => {
  test("agent.fallback used when context.v2.fallback absent", () => {
    const config: PartialConfig = {
      agent: { fallback: { enabled: true, map: { claude: ["codex"] }, maxHopsPerStory: 2, onQualityFailure: false } },
      context: { v2: {} },
    };
    const resolved = config.agent?.fallback ?? config.context?.v2?.fallback;
    expect(resolved?.enabled).toBe(true);
  });

  test("context.v2.fallback used when agent.fallback absent", () => {
    const config: PartialConfig = {
      agent: {},
      context: { v2: { fallback: { enabled: true, map: {}, maxHopsPerStory: 3, onQualityFailure: true } } },
    };
    const resolved = config.agent?.fallback ?? config.context?.v2?.fallback;
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.maxHopsPerStory).toBe(3);
  });

  test("agent.fallback takes precedence over context.v2.fallback", () => {
    const config: PartialConfig = {
      agent: { fallback: { enabled: false, map: {}, maxHopsPerStory: 1, onQualityFailure: false } },
      context: { v2: { fallback: { enabled: true, map: {}, maxHopsPerStory: 5, onQualityFailure: false } } },
    };
    const resolved = config.agent?.fallback ?? config.context?.v2?.fallback;
    expect(resolved?.enabled).toBe(false);
    expect(resolved?.maxHopsPerStory).toBe(1);
  });
});
