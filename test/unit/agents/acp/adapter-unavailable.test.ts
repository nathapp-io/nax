/**
 * Tests for AllAgentsUnavailableError and _unavailableAgents tracking in AcpAgentAdapter.
 *
 * Covers:
 * - AcpAgentAdapter constructor initialises _unavailableAgents as empty Set
 * - markUnavailable(agentName) adds agent to _unavailableAgents
 * - isAvailable(agentName) returns false after markUnavailable
 * - isAvailable(agentName) returns true when agent not marked unavailable
 * - resolveFallbackOrder returns agents after currentAgent, filtering unavailable
 * - AllAgentsUnavailableError extends NaxError with code ALL_AGENTS_UNAVAILABLE
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { AcpAgentAdapter } from "../../../../src/agents/acp/adapter";
import { AllAgentsUnavailableError } from "../../../../src/agents/index";
import { NaxError } from "../../../../src/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal config shape for resolveFallbackOrder tests. */
function makeConfig(fallbackOrder: string[]) {
  return {
    autoMode: {
      fallbackOrder,
    },
  } as unknown as import("../../../../src/config").NaxConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// AcpAgentAdapter — constructor initialises _unavailableAgents
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — _unavailableAgents initialisation", () => {
  test("new AcpAgentAdapter(agentName) initialises _unavailableAgents as empty Set", () => {
    const adapter = new AcpAgentAdapter("claude");
    const unavailable = (adapter as unknown as { _unavailableAgents: Set<string> })._unavailableAgents;
    expect(unavailable).toBeInstanceOf(Set);
    expect(unavailable.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markUnavailable / isAvailable
// ─────────────────────────────────────────────────────────────────────────────

describe("markUnavailable / isAvailable", () => {
  let adapter: AcpAgentAdapter;

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude");
  });

  test("isAvailable returns true for agent not marked unavailable", () => {
    const isAvailable = (adapter as unknown as { isAvailable(name: string): boolean }).isAvailable;
    expect(isAvailable.call(adapter, "codex")).toBe(true);
  });

  test("markUnavailable causes isAvailable to return false for that agent", () => {
    const mark = (adapter as unknown as { markUnavailable(name: string): void }).markUnavailable;
    const isAvailable = (adapter as unknown as { isAvailable(name: string): boolean }).isAvailable;

    mark.call(adapter, "codex");
    expect(isAvailable.call(adapter, "codex")).toBe(false);
  });

  test("markUnavailable does not affect other agents", () => {
    const mark = (adapter as unknown as { markUnavailable(name: string): void }).markUnavailable;
    const isAvailable = (adapter as unknown as { isAvailable(name: string): boolean }).isAvailable;

    mark.call(adapter, "codex");
    expect(isAvailable.call(adapter, "claude")).toBe(true);
    expect(isAvailable.call(adapter, "gemini")).toBe(true);
  });

  test("marking the same agent multiple times does not throw", () => {
    const mark = (adapter as unknown as { markUnavailable(name: string): void }).markUnavailable;
    const isAvailable = (adapter as unknown as { isAvailable(name: string): boolean }).isAvailable;

    mark.call(adapter, "codex");
    mark.call(adapter, "codex");
    expect(isAvailable.call(adapter, "codex")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFallbackOrder
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveFallbackOrder", () => {
  let adapter: AcpAgentAdapter;

  type ResolveFn = (config: ReturnType<typeof makeConfig>, currentAgent: string) => string[];

  beforeEach(() => {
    adapter = new AcpAgentAdapter("claude");
  });

  function resolve(config: ReturnType<typeof makeConfig>, currentAgent: string): string[] {
    return (adapter as unknown as { resolveFallbackOrder: ResolveFn }).resolveFallbackOrder(config, currentAgent);
  }

  test("returns agents after currentAgent when all are available", () => {
    const config = makeConfig(["claude", "codex", "gemini"]);
    const result = resolve(config, "claude");
    expect(result).toEqual(["codex", "gemini"]);
  });

  test("fallbackOrder=['claude','codex'] currentAgent='claude' returns ['codex'] when codex is available", () => {
    const config = makeConfig(["claude", "codex"]);
    const result = resolve(config, "claude");
    expect(result).toEqual(["codex"]);
  });

  test("filters out unavailable agents from the returned list", () => {
    const mark = (adapter as unknown as { markUnavailable(name: string): void }).markUnavailable;
    mark.call(adapter, "codex");

    const config = makeConfig(["claude", "codex", "gemini"]);
    const result = resolve(config, "claude");
    expect(result).toEqual(["gemini"]);
  });

  test("returns empty array when no agents remain after filtering unavailable", () => {
    const mark = (adapter as unknown as { markUnavailable(name: string): void }).markUnavailable;
    mark.call(adapter, "codex");
    mark.call(adapter, "gemini");

    const config = makeConfig(["claude", "codex", "gemini"]);
    const result = resolve(config, "claude");
    expect(result).toEqual([]);
  });

  test("returns empty array when currentAgent is the last in fallbackOrder", () => {
    const config = makeConfig(["claude", "codex"]);
    const result = resolve(config, "codex");
    expect(result).toEqual([]);
  });

  test("returns full list (minus current) when currentAgent is not in fallbackOrder", () => {
    const config = makeConfig(["claude", "codex"]);
    const result = resolve(config, "gemini");
    expect(result).toEqual(["claude", "codex"]);
  });

  test("returns empty array when fallbackOrder is empty", () => {
    const config = makeConfig([]);
    const result = resolve(config, "claude");
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AllAgentsUnavailableError
// ─────────────────────────────────────────────────────────────────────────────

describe("AllAgentsUnavailableError", () => {
  test("extends NaxError", () => {
    const err = new AllAgentsUnavailableError(["claude", "codex"]);
    expect(err).toBeInstanceOf(NaxError);
  });

  test("has code ALL_AGENTS_UNAVAILABLE", () => {
    const err = new AllAgentsUnavailableError(["claude"]);
    expect(err.code).toBe("ALL_AGENTS_UNAVAILABLE");
  });

  test("is an instance of Error", () => {
    const err = new AllAgentsUnavailableError([]);
    expect(err).toBeInstanceOf(Error);
  });

  test("message includes tried agent names", () => {
    const err = new AllAgentsUnavailableError(["claude", "codex"]);
    expect(err.message).toContain("claude");
    expect(err.message).toContain("codex");
  });

  test("name is AllAgentsUnavailableError", () => {
    const err = new AllAgentsUnavailableError(["claude"]);
    expect(err.name).toBe("AllAgentsUnavailableError");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Export from src/agents/index.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AllAgentsUnavailableError export from src/agents/index.ts", () => {
  test("AllAgentsUnavailableError is exported from src/agents barrel", async () => {
    const agentsIndex = await import("../../../../src/agents/index");
    expect(typeof agentsIndex.AllAgentsUnavailableError).toBe("function");
  });
});
