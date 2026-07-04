/**
 * Tests for src/bakeoff/preflight.ts
 *
 * Covers AC-1 through AC-8 of the "CLI compare options and contestant
 * pre-flight" story.
 */

import { describe, expect, it } from "bun:test";
import {
  _preflightDeps,
  assertCompareAgentExclusive,
  computeWorstCaseCost,
  parseCompareList,
  validateContestants,
} from "@/bakeoff";
import { NaxError } from "@/errors";

function withDeps<T>(overrides: Partial<typeof _preflightDeps>, fn: () => T): T {
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = _preflightDeps[key as keyof typeof _preflightDeps];
  }
  Object.assign(_preflightDeps, overrides);
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      // biome-ignore lint: test-only restore
      (_preflightDeps as Record<string, unknown>)[key] = saved[key];
    }
  }
}

describe("parseCompareList", () => {
  // AC-1: comma-separated list with surrounding whitespace
  it("returns trimmed names for 'claude, codex ,gemini'", () => {
    expect(parseCompareList("claude, codex ,gemini")).toEqual(["claude", "codex", "gemini"]);
  });

  // AC-2: empty entries are dropped
  it("drops empty entries for 'claude,,'", () => {
    expect(parseCompareList("claude,,")).toEqual(["claude"]);
  });

  // Adversarial: a string of only commas / whitespace yields an empty list,
  // which the CLI must catch before proceeding with zero contestants.
  it("returns an empty list for ',,,'", () => {
    expect(parseCompareList(",,,")).toEqual([]);
  });

  it("returns an empty list for a string of only whitespace", () => {
    expect(parseCompareList("   ")).toEqual([]);
  });
});

describe("validateContestants", () => {
  // AC-3: both binaries present → no errors
  it("returns no errors and both agents in validAgents when PATH probe reports both binaries present", () => {
    const result = withDeps(
      {
        isInstalled: (name: string) => name === "claude" || name === "codex",
        hasAcpAdapterEntry: (name: string) => name === "claude" || name === "codex",
      },
      () => validateContestants(["claude", "codex"]),
    );
    expect(result.errors).toEqual([]);
    expect(result.validAgents).toEqual(["claude", "codex"]);
  });

  // AC-4: bogus → unknown agent
  it("returns an error identifying 'bogus' as an unknown agent", () => {
    const result = withDeps(
      {
        isInstalled: (_name: string) => false,
        hasAcpAdapterEntry: (_name: string) => true,
      },
      () => validateContestants(["bogus"]),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].agent).toBe("bogus");
    expect(result.errors[0].reason).toBe("unknown-agent");
    expect(result.validAgents).toEqual([]);
  });

  // AC-5: aider is in KNOWN_AGENT_NAMES but has no ACP adapter entry
  it("returns an error for 'aider' because it has no ACP adapter entry", () => {
    const result = withDeps(
      {
        isInstalled: (_name: string) => false,
        hasAcpAdapterEntry: (name: string) => name !== "aider",
      },
      () => validateContestants(["aider"]),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].agent).toBe("aider");
    expect(result.errors[0].reason).toBe("no-acp-adapter");
    expect(result.validAgents).toEqual([]);
  });

  // AC-6: gemini binary absent on PATH → dnf-not-installed
  it("returns dnf-not-installed when PATH probe reports the binary absent", () => {
    const result = withDeps(
      {
        isInstalled: (_name: string) => false,
        hasAcpAdapterEntry: (name: string) => name === "gemini",
      },
      () => validateContestants(["gemini"]),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].agent).toBe("gemini");
    expect(result.errors[0].reason).toBe("dnf-not-installed");
    expect(result.validAgents).toEqual([]);
  });

  it("accepts per-call deps without mutating the module _preflightDeps", () => {
    const deps = {
      isInstalled: (name: string) => name === "claude",
      hasAcpAdapterEntry: (name: string) => name === "claude",
    };
    const result = validateContestants(["claude", "bogus"], deps);
    expect(result.validAgents).toEqual(["claude"]);
    expect(result.errors.map((e) => e.agent)).toEqual(["bogus"]);
  });
});

describe("assertCompareAgentExclusive", () => {
  // AC-7: --compare + --agent → NaxError with code identifying the conflict
  it("throws NaxError identifying the --compare and --agent conflict", () => {
    try {
      assertCompareAgentExclusive({ compare: "claude", agent: "codex" });
      throw new Error("expected NaxError to be thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const naxErr = err as NaxError;
      expect(naxErr.code).toBe("COMPARE_AGENT_EXCLUSIVE");
      expect(naxErr.message).toContain("--compare");
      expect(naxErr.message).toContain("--agent");
    }
  });

  it("does not throw when only --compare is set", () => {
    expect(() => assertCompareAgentExclusive({ compare: "claude" })).not.toThrow();
  });

  it("does not throw when only --agent is set", () => {
    expect(() => assertCompareAgentExclusive({ agent: "claude" })).not.toThrow();
  });

  it("does not throw when neither flag is set", () => {
    expect(() => assertCompareAgentExclusive({})).not.toThrow();
  });
});

describe("computeWorstCaseCost", () => {
  // AC-8: N × max-cost
  it("returns contestantCount * maxCostPerContestant (3 * 5 = 15)", () => {
    expect(computeWorstCaseCost(3, 5)).toBe(15);
  });
});
