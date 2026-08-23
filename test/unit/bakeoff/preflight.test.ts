/**
 * Tests for src/bakeoff/preflight.ts
 *
 * `validateContestants` / `buildContestantConfig` cover US-001 AC-1 through
 * AC-11 ("Resolve profile contestants"); the remaining describe blocks cover
 * the original "CLI compare options and contestant pre-flight" story.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  assertCompareAgentExclusive,
  buildContestantConfig,
  computeWorstCaseCost,
  parseCompareList,
  reclaimStaleBakeoffBranches,
  validateContestants,
} from "@/bakeoff";
import { NaxError } from "@/errors";
import { getSafeLogger, initLogger, resetLogger } from "@/logger";
import { _gitDeps } from "@/utils/git";
import { makeNaxConfig } from "@test/helpers";

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
  const projectRoot = "/tmp/bakeoff-fixture-project";

  function fakeLoadProfile(
    resolvable: Record<string, Record<string, unknown>>,
  ): (profileName: string, root: string) => Promise<Record<string, unknown>> {
    return async (profileName: string) => {
      const data = resolvable[profileName];
      if (!data) throw new NaxError(`Profile "${profileName}" not found. Available: (none)`, "PROFILE_NOT_FOUND", {});
      return data;
    };
  }

  // AC-1: a resolvable profile name resolves cleanly
  it("US-001: returns validAgents containing 'cross-agent-pi' and no errors when the profile resolves", async () => {
    const result = await validateContestants(["cross-agent-pi"], projectRoot, {
      isInstalled: () => true,
      hasAcpAdapterEntry: () => true,
      loadProfile: fakeLoadProfile({ "cross-agent-pi": { agent: { default: "claude" } } }),
    });
    expect(result.errors).toEqual([]);
    expect(result.validAgents).toEqual(["cross-agent-pi"]);
  });

  // AC-2: an unresolvable profile yields reason unknown-profile
  it("US-001: returns one error with reason unknown-profile when the profile does not resolve", async () => {
    const result = await validateContestants(["ghost-profile"], projectRoot, {
      isInstalled: () => true,
      hasAcpAdapterEntry: () => true,
      loadProfile: fakeLoadProfile({}),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].agent).toBe("ghost-profile");
    expect(result.errors[0].reason).toBe("unknown-profile");
    expect(result.validAgents).toEqual([]);
  });

  // AC-3: one unresolvable + one resolvable in the same call
  it("US-001: omits the unresolvable profile while retaining the resolvable one", async () => {
    const result = await validateContestants(["ghost-profile", "cross-agent-mm"], projectRoot, {
      isInstalled: () => true,
      hasAcpAdapterEntry: () => true,
      loadProfile: fakeLoadProfile({ "cross-agent-mm": { agent: { default: "codex" } } }),
    });
    expect(result.validAgents).toEqual(["cross-agent-mm"]);
    expect(result.errors.map((e) => e.agent)).toEqual(["ghost-profile"]);
  });

  // AC-4: the error message names the unresolvable profile
  it("US-001: the unresolvable-profile error message contains the profile name", async () => {
    const result = await validateContestants(["ghost-profile"], projectRoot, {
      isInstalled: () => true,
      hasAcpAdapterEntry: () => true,
      loadProfile: fakeLoadProfile({}),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message ?? "").toContain("ghost-profile");
  });

  // AC-5: loadProfile is invoked once per contestant name, name first
  it("US-001: invokes loadProfile once per contestant name with that name as the first argument", async () => {
    const calls: Array<[string, string]> = [];
    const loadProfile = async (profileName: string, root: string) => {
      calls.push([profileName, root]);
      return { agent: { default: "claude" } };
    };
    await validateContestants(["cross-agent-pi", "cross-agent-mm"], projectRoot, {
      isInstalled: () => true,
      hasAcpAdapterEntry: () => true,
      loadProfile,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe("cross-agent-pi");
    expect(calls[1][0]).toBe("cross-agent-mm");
  });

  // AC-6: resolved profile's agent.default has no ACP adapter entry
  it("US-001: returns reason no-acp-adapter when the profile's agent.default has no adapter entry", async () => {
    const result = await validateContestants(["cross-agent-pi"], projectRoot, {
      isInstalled: () => true,
      hasAcpAdapterEntry: () => false,
      loadProfile: fakeLoadProfile({ "cross-agent-pi": { agent: { default: "not-a-real-agent" } } }),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("no-acp-adapter");
    expect(result.validAgents).toEqual([]);
  });

  // AC-7: resolved profile's agent binary is absent from PATH
  it("US-001: returns reason dnf-not-installed when the profile's agent binary is absent from PATH", async () => {
    const result = await validateContestants(["cross-agent-pi"], projectRoot, {
      isInstalled: () => false,
      hasAcpAdapterEntry: () => true,
      loadProfile: fakeLoadProfile({ "cross-agent-pi": { agent: { default: "claude" } } }),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("dnf-not-installed");
    expect(result.validAgents).toEqual([]);
  });

  // Regression: a loadProfile failure that is NOT "this profile name does
  // not resolve" (e.g. malformed profile JSON) must not be silently
  // downgraded to reason=unknown-profile — it propagates instead.
  it("US-001: propagates a non-resolution loadProfile error instead of reporting unknown-profile", async () => {
    const boom = new Error("Unexpected end of JSON input");
    await expect(
      validateContestants(["cross-agent-pi"], projectRoot, {
        isInstalled: () => true,
        hasAcpAdapterEntry: () => true,
        loadProfile: async () => {
          throw boom;
        },
      }),
    ).rejects.toThrow(boom);
  });
});

describe("buildContestantConfig", () => {
  // AC-8: a key set exclusively by the profile overlay resolves to the profile's value
  it("US-001: resolves a profile-only key to the profile's value", () => {
    const base = makeNaxConfig();
    const merged = buildContestantConfig(base, { name: "profile-only-name" });
    expect(merged.name).toBe("profile-only-name");
  });

  // AC-9: a key set by both base and overlay resolves to the profile's value
  it("US-001: resolves a key set by both base and overlay to the profile's value", () => {
    const base = makeNaxConfig({ name: "base-name" });
    const merged = buildContestantConfig(base, { name: "overlay-name" });
    expect(merged.name).toBe("overlay-name");
  });

  // AC-10: agent.default equals the profile's agent.default
  it("US-001: sets agent.default to the profile's agent.default", () => {
    const base = makeNaxConfig();
    const merged = buildContestantConfig(base, { agent: { default: "cross-agent-pi-resolved-agent" } });
    expect(merged.agent?.default).toBe("cross-agent-pi-resolved-agent");
  });

  // AC-11: agent.fallback.enabled is pinned to false even when the overlay sets it true
  it("US-001: pins agent.fallback.enabled to false when the overlay sets it true", () => {
    const base = makeNaxConfig();
    const merged = buildContestantConfig(base, { agent: { fallback: { enabled: true } } });
    expect(merged.agent?.fallback?.enabled).toBe(false);
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

describe("reclaimStaleBakeoffBranches — failed branch deletion", () => {
  let origSpawn: typeof _gitDeps.spawn;

  beforeEach(() => {
    origSpawn = _gitDeps.spawn;
    resetLogger();
    initLogger({ level: "silent" });
  });

  afterEach(() => {
    _gitDeps.spawn = origSpawn;
    resetLogger();
  });

  function mockSpawnFor(handler: (args: string[]) => { output: string; exitCode: number }): typeof _gitDeps.spawn {
    return mock((args: string[], _opts: unknown) => {
      const { output, exitCode } = handler(args);
      const bytes = new TextEncoder().encode(output);
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        exited: Promise.resolve(exitCode),
        kill: mock(() => {}),
      };
    }) as typeof _gitDeps.spawn;
  }

  // A stale branch whose `git branch -D` call fails must be logged as a
  // warning, not silently dropped — otherwise preflight can report success
  // while the branch still blocks worktree creation.
  it("logs a warning when git branch -D fails for a stale bake-off branch", async () => {
    const staleBranch = "nax/bakeoff-stale-id";
    _gitDeps.spawn = mockSpawnFor((args) => {
      // args[0] is the "git" executable itself — the subcommand is args[1].
      if (args[1] === "for-each-ref") return { output: `${staleBranch}\n`, exitCode: 0 };
      if (args[1] === "worktree") return { output: "worktree /repo\nHEAD abc123\n", exitCode: 0 };
      if (args[1] === "branch" && args[2] === "-D") {
        return { output: "", exitCode: 1 };
      }
      return { output: "", exitCode: 0 };
    });

    const logger = getSafeLogger();
    if (!logger) throw new Error("expected logger to be initialized");
    const warnSpy = spyOn(logger, "warn");

    await reclaimStaleBakeoffBranches("/repo");

    expect(warnSpy).toHaveBeenCalled();
    const call = warnSpy.mock.calls.find((c) => String(c[1]).includes("Failed to delete stale bake-off branch"));
    expect(call).toBeDefined();
    expect((call?.[2] as { branch?: string } | undefined)?.branch).toBe(staleBranch);
  });

  // ENH-3 regression: before deleting a stale bake-off branch, the
  // preflight must log its tip SHA so a mistaken delete is recoverable
  // (`git checkout <sha>` / `git branch <name> <sha>`). The previous
  // implementation force-deleted `nax/bakeoff-*` branches without any
  // breadcrumb, which silently lost unmerged work in a shared namespace
  // (docs/20260816-review-since-0.80.0-canary.3.md, ENH-3).
  it("ENH-3 regression: logs the branch tip SHA before deleting a stale bake-off branch", async () => {
    const staleBranch = "nax/bakeoff-stale-id";
    const tipSha = "deadbeef1234567890abcdef1234567890abcdef";
    _gitDeps.spawn = mockSpawnFor((args) => {
      if (args[1] === "for-each-ref") return { output: `${staleBranch}\n`, exitCode: 0 };
      if (args[1] === "worktree") return { output: "worktree /repo\nHEAD abc123\n", exitCode: 0 };
      // rev-parse <branch> → SHA (called before `git branch -D`).
      if (args[1] === "rev-parse") return { output: `${tipSha}\n`, exitCode: 0 };
      if (args[1] === "branch" && args[2] === "-D") return { output: "", exitCode: 0 };
      return { output: "", exitCode: 0 };
    });

    const logger = getSafeLogger();
    if (!logger) throw new Error("expected logger to be initialized");
    const warnSpy = spyOn(logger, "warn");

    await reclaimStaleBakeoffBranches("/repo");

    // The pre-delete warn must include the SHA so a user can recover
    // (`git checkout <sha>` / `git branch <name> <sha>`).
    const reclaimCall = warnSpy.mock.calls.find((c) => String(c[1]).includes("Reclaiming stale bake-off branch"));
    expect(reclaimCall).toBeDefined();
    const ctx = reclaimCall?.[2] as { branch?: string; sha?: string; projectRoot?: string } | undefined;
    expect(ctx?.branch).toBe(staleBranch);
    expect(ctx?.sha).toBe(tipSha);
    expect(ctx?.projectRoot).toBe("/repo");
  });

  // ENH-3 regression (defensive): when rev-parse fails (e.g. branch
  // already deleted by a concurrent run), the deletion must still
  // proceed — the SHA log is best-effort observability, not a gate.
  it("ENH-3 regression: still deletes the branch when rev-parse fails (SHA log is best-effort)", async () => {
    const staleBranch = "nax/bakeoff-stale-id";
    _gitDeps.spawn = mockSpawnFor((args) => {
      if (args[1] === "for-each-ref") return { output: `${staleBranch}\n`, exitCode: 0 };
      if (args[1] === "worktree") return { output: "worktree /repo\nHEAD abc123\n", exitCode: 0 };
      // rev-parse fails — concurrent deletion or unparseable ref.
      if (args[1] === "rev-parse") return { output: "", exitCode: 128 };
      // Delete must still be attempted.
      if (args[1] === "branch" && args[2] === "-D") return { output: "", exitCode: 0 };
      return { output: "", exitCode: 0 };
    });

    const logger = getSafeLogger();
    if (!logger) throw new Error("expected logger to be initialized");
    const warnSpy = spyOn(logger, "warn");

    await reclaimStaleBakeoffBranches("/repo");

    // The reclaim warn still fires, but without a sha field — the
    // deletion is logged as best-effort.
    const reclaimCall = warnSpy.mock.calls.find((c) => String(c[1]).includes("Reclaiming stale bake-off branch"));
    expect(reclaimCall).toBeDefined();
    const ctx = reclaimCall?.[2] as { branch?: string; sha?: string | null } | undefined;
    expect(ctx?.branch).toBe(staleBranch);
    expect(ctx?.sha == null || ctx?.sha === "").toBe(true);
    // And the failure-deletion warn must NOT have fired (delete succeeded).
    const failureCall = warnSpy.mock.calls.find((c) => String(c[1]).includes("Failed to delete stale bake-off branch"));
    expect(failureCall).toBeUndefined();
  });
});
