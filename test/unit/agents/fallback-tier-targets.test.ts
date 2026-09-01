/**
 * Tier-aware fallback targets.
 *
 * The schema is the easy half. The reason these tests assert at the seams and
 * not only at the parse is that widening the schema alone ships an inert
 * feature: the tier would be parsed, filtered, and then dropped by a
 * nextCandidate that returns a bare string.
 */

import { describe, expect, test } from "bun:test";
import { AgentManager } from "@/agents/manager";
import { availableCandidates, credentialCandidates, normaliseFallbackTarget } from "@/agents/swap-decision";
import { NaxConfigSchema } from "@/config/schemas";

const none = () => false;

describe("fallback map schema", () => {
  test("accepts plain strings, as today", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { claude: ["codex", "gemini"] } } },
    });
    expect(config.agent?.fallback?.map.claude).toEqual(["codex", "gemini"]);
  });

  test("accepts a { agent, tier } target", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { native: [{ agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.native).toEqual([{ agent: "native", tier: "cheap" }]);
  });

  test("accepts both forms mixed in one entry", () => {
    const config = NaxConfigSchema.parse({
      agent: { fallback: { enabled: true, map: { claude: ["codex", { agent: "native", tier: "cheap" }] } } },
    });
    expect(config.agent?.fallback?.map.claude).toHaveLength(2);
  });

  test("rejects an object target missing agent", () => {
    expect(() =>
      NaxConfigSchema.parse({
        agent: { fallback: { enabled: true, map: { claude: [{ tier: "cheap" }] } } },
      }),
    ).toThrow();
  });
});

describe("normaliseFallbackTarget", () => {
  test("a string becomes an agent with no tier", () => {
    expect(normaliseFallbackTarget("codex")).toEqual({ agent: "codex" });
  });

  test("an object keeps its tier", () => {
    expect(normaliseFallbackTarget({ agent: "native", tier: "cheap" })).toEqual({ agent: "native", tier: "cheap" });
  });
});

describe("availableCandidates", () => {
  test("plain strings behave exactly as before", () => {
    expect(availableCandidates({ claude: ["codex", "gemini"] }, "claude", none)).toEqual([
      { agent: "codex" },
      { agent: "gemini" },
    ]);
  });

  test("preserves the tier on an object target", () => {
    expect(availableCandidates({ native: [{ agent: "native", tier: "cheap" }] }, "native", none)).toEqual([
      { agent: "native", tier: "cheap" },
    ]);
  });

  test("exclusion still filters by agent name", () => {
    const excluded = (c: string) => c === "codex";
    expect(availableCandidates({ claude: ["codex", { agent: "native", tier: "cheap" }] }, "claude", excluded)).toEqual([
      { agent: "native", tier: "cheap" },
    ]);
  });
});

describe("credentialCandidates", () => {
  test("yields names for both forms, so validateCredentials checks both sides", () => {
    const got = credentialCandidates({ claude: ["codex", { agent: "native", tier: "cheap" }] }, "claude");
    expect([...got].sort()).toEqual(["claude", "codex", "native"]);
  });
});

describe("nextCandidate", () => {
  function manager(map: Record<string, unknown[]>) {
    const config = NaxConfigSchema.parse({
      agent: { default: "claude", fallback: { enabled: true, map } },
    });
    return new AgentManager(config);
  }

  test("returns a bare agent for a plain-string target", () => {
    expect(manager({ claude: ["codex"] }).nextCandidate("claude", 0)).toEqual({ agent: "codex" });
  });

  test("returns the tier for an object target", () => {
    expect(manager({ claude: [{ agent: "native", tier: "cheap" }] }).nextCandidate("claude", 0)).toEqual({
      agent: "native",
      tier: "cheap",
    });
  });

  test("returns null when the chain is empty", () => {
    expect(manager({ claude: [] }).nextCandidate("claude", 0)).toBeNull();
  });
});
