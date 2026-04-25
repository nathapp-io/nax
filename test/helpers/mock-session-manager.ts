import { mock } from "bun:test";
import type { SessionHandle, TurnResult } from "../../src/agents/types";
import type { ISessionManager, SessionDescriptor } from "../../src/session/types";

/**
 * Minimal ISessionManager mock. All methods are no-op stubs returning sensible defaults.
 * Pass `overrides` to customize behavior for the specific test.
 */
export function makeSessionManager(overrides: Partial<ISessionManager> = {}): ISessionManager {
  const stubDescriptor = { id: "mock-session", state: "CREATED" } as unknown as SessionDescriptor;
  const stubHandle: SessionHandle = { id: "mock-session", agentName: "claude" };
  const stubTurnResult: TurnResult = {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    internalRoundTrips: 0,
  };
  return {
    create: mock(() => stubDescriptor),
    get: mock(() => null),
    transition: mock(() => stubDescriptor),
    bindHandle: mock(() => stubDescriptor),
    resume: mock(() => null),
    // Returns legacy AgentResult shape. Phase B callers (prompt/callback overloads)
    // expect TurnResult — override this stub when testing Phase B runInSession usage.
    runInSession: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    })),
    listActive: mock(() => [] as SessionDescriptor[]),
    closeStory: mock(() => [] as SessionDescriptor[]),
    getForStory: mock(() => [] as SessionDescriptor[]),
    sweepOrphans: mock(() => 0),
    openSession: mock(async () => stubHandle),
    closeSession: mock(async () => {}),
    sendPrompt: mock(async () => stubTurnResult),
    nameFor: mock(() => "nax-00000000"),
    descriptor: mock(() => null),
    ...overrides,
  } as ISessionManager;
}
