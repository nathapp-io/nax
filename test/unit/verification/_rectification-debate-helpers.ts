/**
 * Shared test helpers for rectification-loop debate tests (US-005).
 */

import { mock } from "bun:test";
import type { AgentRunOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";

export const FAILING_TEST_OUTPUT =
  "✗ my test [1ms]\n(fail) my test [1ms]\nerror: Expected 1 to be 2";

export function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "TS-001",
    title: "Implement feature",
    description: "Implement the feature",
    acceptanceCriteria: ["Test passes"],
    status: "pending",
    routing: { modelTier: "balanced" },
    ...overrides,
  } as UserStory;
}

export function makeConfig(debateEnabled = false, overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    autoMode: {
      defaultAgent: "claude",
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        tierOrder: [{ tier: "balanced" }],
      },
    },
    execution: {
      sessionTimeoutSeconds: 120,
      rectification: {
        maxRetries: 2,
        abortOnRegression: true,
      },
      permissionProfile: "cautious",
    },
    models: {
      claude: {
        balanced: { provider: "anthropic", model: "claude-haiku-4-5" },
      },
    },
    agent: {
      maxInteractionTurns: 5,
    },
    quality: {
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      drainTimeoutMs: 0,
    },
    debate: {
      enabled: debateEnabled,
      agents: 2,
      stages: {
        plan: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        review: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        acceptance: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
        rectification: {
          enabled: debateEnabled,
          resolver: { type: "synthesis" },
          sessionMode: "one-shot",
          rounds: 1,
          debaters: [
            { agent: "claude", model: "claude-haiku-4-5" },
            { agent: "claude", model: "claude-sonnet-4-6" },
          ],
        },
        escalation: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
      },
    },
    ...overrides,
  } as unknown as NaxConfig;
}

export function makeAgent(overrides: Partial<{ run: typeof mock; complete: typeof mock }> = {}) {
  return {
    name: "claude",
    run: mock(async (_opts: AgentRunOptions) => ({
      success: true,
      exitCode: 0,
      output: "done",
      rateLimited: false,
      durationMs: 10,
      estimatedCostUsd: 0,
    })),
    complete: mock(async (_prompt: string) => ""),
    isInstalled: mock(async () => true),
    buildCommand: mock((_opts: AgentRunOptions) => ["claude"]),
    buildAllowedEnv: mock((_opts?: AgentRunOptions) => ({})),
    ...overrides,
  };
}
