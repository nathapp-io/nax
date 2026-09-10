import { describe, expect, test } from "bun:test";
import { resolveStartAgent } from "@/agents/hop-budget";
import type { FallbackTarget } from "@/agents/swap-decision";

function source(cooling: ReadonlySet<string>, candidate: FallbackTarget | null) {
  return {
    isUnavailable: (agent: string, tier?: string, model?: string) =>
      cooling.has(`${agent}::${tier ?? ""}::${model ?? ""}`),
    nextCandidate: () => candidate,
  };
}

describe("resolveStartAgent() with an endpoint", () => {
  test("starts on the primary when this endpoint is healthy, even if another is cooling", () => {
    const cooling = new Set(["native::balanced::"]);
    const start = resolveStartAgent(source(cooling, { agent: "claude" }), "native", true, "US-1", null, {
      tier: "codex-mini",
    });
    expect(start).toEqual({ agent: "native" });
  });

  test("skips to the first live candidate when THIS endpoint is cooling", () => {
    const cooling = new Set(["native::balanced::"]);
    const start = resolveStartAgent(
      source(cooling, { agent: "native", tier: "powerful" }),
      "native",
      true,
      "US-1",
      null,
      { tier: "balanced" },
    );
    expect(start).toEqual({ agent: "native", tier: "powerful" });
  });

  test("with no endpoint given it reads the bare-agent key, as before", () => {
    const cooling = new Set(["native::::"]);
    const start = resolveStartAgent(source(cooling, { agent: "claude" }), "native", true, "US-1", null);
    expect(start).toEqual({ agent: "claude" });
  });

  test("fallback disabled always returns the primary", () => {
    const cooling = new Set(["native::balanced::"]);
    const start = resolveStartAgent(source(cooling, { agent: "claude" }), "native", false, "US-1", null, {
      tier: "balanced",
    });
    expect(start).toEqual({ agent: "native" });
  });
});
