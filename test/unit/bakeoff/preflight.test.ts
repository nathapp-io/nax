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
});

describe("validateContestants", () => {
  // AC-3: both binaries present → no errors
  it("returns no errors when PATH probe reports both binaries present", () => {
    const errors = withDeps(
      {
        which: (name: string) => {
          if (name === "claude" || name === "codex") return `/usr/local/bin/${name}`;
          return null;
        },
        hasAcpAdapterEntry: (name: string) => name === "claude" || name === "codex",
      },
      () => validateContestants(["claude", "codex"]),
    );
    expect(errors).toEqual([]);
  });

  // AC-4: bogus → unknown agent
  it("returns an error identifying 'bogus' as an unknown agent", () => {
    const errors = withDeps(
      {
        which: (_name: string) => null,
        hasAcpAdapterEntry: (_name: string) => true,
      },
      () => validateContestants(["bogus"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].agent).toBe("bogus");
    expect(errors[0].reason).toBe("unknown-agent");
  });

  // AC-5: aider is in KNOWN_AGENT_NAMES but has no ACP adapter entry
  it("returns an error for 'aider' because it has no ACP adapter entry", () => {
    const errors = withDeps(
      {
        which: (_name: string) => null,
        hasAcpAdapterEntry: (name: string) => name !== "aider",
      },
      () => validateContestants(["aider"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].agent).toBe("aider");
    expect(errors[0].reason).toBe("no-acp-adapter");
  });

  // AC-6: gemini binary absent on PATH → dnf-not-installed
  it("returns dnf-not-installed when PATH probe reports the binary absent", () => {
    const errors = withDeps(
      {
        which: (_name: string) => null,
        hasAcpAdapterEntry: (name: string) => name === "gemini",
      },
      () => validateContestants(["gemini"]),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].agent).toBe("gemini");
    expect(errors[0].reason).toBe("dnf-not-installed");
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
      const code = (err as NaxError).code;
      expect(code.toLowerCase()).toContain("compare");
      expect(code.toLowerCase()).toContain("agent");
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
