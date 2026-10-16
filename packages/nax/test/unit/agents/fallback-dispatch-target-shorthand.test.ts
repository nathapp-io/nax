/**
 * nax#2571: a fallback target `{ agent, model }` is classified exactly like
 * `resolveConfiguredModel` classifies it. A shorthand name (`opus`) is a model
 * pin, never the agent's tier; a tier name with an `[effort]` suffix is still
 * that tier, and the dropped effort is reported.
 */
import { describe, expect, test } from "bun:test";
import { resolveFallbackDispatchTarget, sameFallbackHop } from "@/agents/fallback-model-identity";
import type { ModelsConfig } from "@/config";
import { addSink, initLogger, resetLogger } from "@/logger";

const models: ModelsConfig = {
  claude: { fast: "haiku", balanced: "sonnet[medium]", powerful: "sonnet[medium]" },
  native: {
    powerful: { provider: "openrouter", model: "deepseek/deepseek-v4[medium]", env: { KEY: "x" } },
  },
  opencode: { powerful: "minimax/MiniMax-M2.7" },
};

/** Run `fn` with a warn-level logger and collect every `warn` message it emits. */
function warnMessages(fn: () => void): string[] {
  const messages: string[] = [];
  resetLogger();
  initLogger({ level: "warn" });
  const removeSink = addSink((entry) => {
    if (entry.level === "warn") messages.push(entry.message);
  });
  try {
    fn();
  } finally {
    removeSink();
    resetLogger();
  }
  return messages;
}

const LITERAL_WARN = "Fallback target model is neither a tier nor a recognizable model id — dispatching as a literal";
const EFFORT_WARN = "Fallback target effort suffix is ignored: a fallback tier carries no effort";

describe("resolveFallbackDispatchTarget: shorthand names (nax#2571)", () => {
  test("claude opus[medium] stays a pin, without a warning", () => {
    const messages = warnMessages(() => {
      expect(resolveFallbackDispatchTarget(models, "claude", { agent: "claude", model: "opus[medium]" })).toEqual({
        agent: "claude",
        model: "opus[medium]",
      });
    });
    expect(messages).not.toContain(LITERAL_WARN);
  });

  test("claude opus (no suffix) stays a pin", () => {
    expect(resolveFallbackDispatchTarget(models, "claude", { agent: "claude", model: "opus" })).toEqual({
      agent: "claude",
      model: "opus",
    });
  });

  test("opencode opus stays a pin, not the opencode powerful tier, and warns", () => {
    const messages = warnMessages(() => {
      expect(resolveFallbackDispatchTarget(models, "claude", { agent: "opencode", model: "opus" })).toEqual({
        agent: "opencode",
        model: "opus",
      });
    });
    expect(messages).toContain(LITERAL_WARN);
  });

  test("a bare tier name becomes the tier spelling", () => {
    expect(resolveFallbackDispatchTarget(models, "claude", { agent: "native", model: "powerful" })).toEqual({
      agent: "native",
      tier: "powerful",
    });
  });

  test("a suffixed tier name keeps its tier (object entry intact) and warns that the effort is dropped", () => {
    const messages = warnMessages(() => {
      expect(resolveFallbackDispatchTarget(models, "claude", { agent: "native", model: "powerful[high]" })).toEqual({
        agent: "native",
        tier: "powerful",
      });
    });
    expect(messages).toContain(EFFORT_WARN);
  });

  test("the converted target is the same hop as its tier twin (exclusion parity)", () => {
    const converted = resolveFallbackDispatchTarget(models, "claude", { agent: "native", model: "powerful[high]" });
    expect(
      sameFallbackHop(
        models,
        "claude",
        "native",
        converted.agent,
        "powerful",
        undefined,
        converted.tier,
        converted.model,
      ),
    ).toBe(true);
  });
});
