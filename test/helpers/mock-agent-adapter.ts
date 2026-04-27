import { mock } from "bun:test";
import type { AgentAdapter, CompleteResult, SessionHandle, TurnResult } from "../../src/agents/types";

const DEFAULT_COMPLETE_RESULT: CompleteResult = {
  output: "",
  costUsd: 0,
  source: "fallback" as const,
};

const DEFAULT_SESSION_HANDLE: SessionHandle = {
  id: "mock-session",
  agentName: "mock",
};

const DEFAULT_TURN_RESULT: TurnResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  internalRoundTrips: 1,
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
    buildCommand: mock(() => []),
    plan: mock(() => Promise.resolve({ specContent: "", estimatedCost: 0 })),
    decompose: mock(() => Promise.resolve({ stories: [] })),
    complete: mock(() => Promise.resolve(DEFAULT_COMPLETE_RESULT)),
    closePhysicalSession: mock(() => Promise.resolve()),
    openSession: mock(() => Promise.resolve(DEFAULT_SESSION_HANDLE)),
    sendTurn: mock(() => Promise.resolve(DEFAULT_TURN_RESULT)),
    closeSession: mock(() => Promise.resolve()),
    ...overrides,
  } as AgentAdapter;
}
