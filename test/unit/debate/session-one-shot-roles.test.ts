import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateSession, _debateSessionDeps } from "../../../src/debate/session";
import type { DebateStageConfig } from "../../../src/debate/types";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
    debaters: [{ agent: "opencode" }, { agent: "opencode" }],
    timeoutSeconds: 60,
    ...overrides,
  };
}

describe("DebateSession.runOneShot() session roles", () => {
  let origGetAgent: typeof _debateSessionDeps.getAgent;

  beforeEach(() => {
    origGetAgent = _debateSessionDeps.getAgent;
  });

  afterEach(() => {
    _debateSessionDeps.getAgent = origGetAgent;
  });

  test("uses indexed session roles for proposal round", async () => {
    const roles: string[] = [];

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async () => ({ specContent: "" }),
      decompose: async () => ({ stories: [] }),
      complete: async (_prompt: string, options?: { sessionRole?: string }) => {
        roles.push(options?.sessionRole ?? "");
        return { output: "{\"passed\":true}", costUsd: 0, source: "fallback" as const };
      },
    }));

    const session = new DebateSession({
      storyId: "US-ROLE",
      stage: "review",
      stageConfig: makeStageConfig(),
    });

    await session.run("prompt");

    const proposalRoles = roles.filter((role) => role.startsWith("debate-proposal"));
    expect(proposalRoles).toEqual(["debate-proposal-0", "debate-proposal-1"]);
  });

  test("uses indexed session roles for critique round", async () => {
    const roles: string[] = [];

    _debateSessionDeps.getAgent = mock(() => ({
      name: "opencode",
      displayName: "opencode",
      binary: "opencode",
      capabilities: {
        supportedTiers: ["fast"] as const,
        maxContextTokens: 100_000,
        features: new Set<"review" | "tdd" | "refactor" | "batch">(["review"]),
      },
      isInstalled: async () => true,
      run: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      }),
      buildCommand: () => [],
      plan: async () => ({ specContent: "" }),
      decompose: async () => ({ stories: [] }),
      complete: async (_prompt: string, options?: { sessionRole?: string }) => {
        roles.push(options?.sessionRole ?? "");
        return { output: "{\"passed\":true}", costUsd: 0, source: "fallback" as const };
      },
    }));

    const session = new DebateSession({
      storyId: "US-ROLE",
      stage: "review",
      stageConfig: makeStageConfig({
        rounds: 2,
        resolver: { type: "synthesis" },
      }),
    });

    await session.run("prompt");

    const critiqueRoles = roles.filter((role) => role.startsWith("debate-critique"));
    expect(critiqueRoles).toEqual(["debate-critique-0", "debate-critique-1"]);
  });
});
