import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("AgentConfigSchema", () => {
  test("default values", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent).toBeDefined();
    expect(result.agent?.protocol).toBe("acp");
    expect(result.agent?.default).toBe("claude");
    expect(result.agent?.maxInteractionTurns).toBe(20);
    expect(result.agent?.fallback.enabled).toBe(false);
    expect(result.agent?.fallback.map).toEqual({});
    expect(result.agent?.fallback.maxHopsPerStory).toBe(2);
    expect(result.agent?.fallback.onQualityFailure).toBe(false);
    expect(result.agent?.fallback.rebuildContext).toBe(true);
  });

  test("accepts a fully populated agent block", () => {
    const raw = {
      agent: {
        protocol: "acp",
        default: "codex",
        maxInteractionTurns: 30,
        fallback: {
          enabled: true,
          map: { claude: ["codex"], codex: ["claude"] },
          maxHopsPerStory: 3,
          onQualityFailure: true,
          rebuildContext: false,
        },
      },
    };
    const result = NaxConfigSchema.parse(raw);
    expect(result.agent?.default).toBe("codex");
    expect(result.agent?.fallback.map).toEqual({ claude: ["codex"], codex: ["claude"] });
  });

  test("rejects empty default", () => {
    expect(() => NaxConfigSchema.parse({ agent: { default: "" } })).toThrow();
  });

  test("rejects maxHopsPerStory out of range", () => {
    expect(() =>
      NaxConfigSchema.parse({ agent: { fallback: { maxHopsPerStory: 0 } } }),
    ).toThrow();
    expect(() =>
      NaxConfigSchema.parse({ agent: { fallback: { maxHopsPerStory: 11 } } }),
    ).toThrow();
  });

  test("agent.acp.promptRetries defaults to 0", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.acp?.promptRetries).toBe(0);
  });

  test("agent.acp.promptRetries accepts values 0–5", () => {
    for (const n of [0, 1, 3, 5]) {
      const result = NaxConfigSchema.parse({ agent: { acp: { promptRetries: n } } });
      expect(result.agent?.acp?.promptRetries).toBe(n);
    }
  });

  test("agent.acp.promptRetries rejects values out of range", () => {
    expect(() => NaxConfigSchema.parse({ agent: { acp: { promptRetries: -1 } } })).toThrow();
    expect(() => NaxConfigSchema.parse({ agent: { acp: { promptRetries: 6 } } })).toThrow();
  });
});
