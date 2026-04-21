import { mock } from "bun:test";
import type { AgentAdapter, AgentResult, CompleteResult } from "../../src/agents/types";

const DEFAULT_RUN_RESULT: AgentResult = {
  success: true,
  exitCode: 0,
  output: "",
  rateLimited: false,
  durationMs: 0,
  estimatedCost: 0,
};

const DEFAULT_COMPLETE_RESULT: CompleteResult = {
  output: "",
  costUsd: 0,
  source: "fallback" as const,
};

export function makeAgentAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock Adapter",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 200_000,
      features: new Set(["tdd", "review", "refactor", "batch"]),
    },
    isInstalled: mock(() => Promise.resolve(true)),
    run: mock(() => Promise.resolve(DEFAULT_RUN_RESULT)),
    buildCommand: mock(() => []),
    plan: mock(() => Promise.resolve({ specContent: "", estimatedCost: 0 })),
    decompose: mock(() => Promise.resolve({ stories: [] })),
    complete: mock(() => Promise.resolve(DEFAULT_COMPLETE_RESULT)),
    deriveSessionName: mock(() => ""),
    closePhysicalSession: mock(() => Promise.resolve()),
    closeSession: mock(() => Promise.resolve()),
    ...overrides,
  } as AgentAdapter;
}
