import { mock } from "bun:test";
import type { ISessionManager, SessionDescriptor } from "../../src/session/types";

/**
 * Minimal ISessionManager mock. All methods are no-op stubs returning sensible defaults.
 * Pass `overrides` to customize behavior for the specific test.
 */
export function makeSessionManager(overrides: Partial<ISessionManager> = {}): ISessionManager {
  const stubDescriptor = { id: "mock-session", state: "CREATED" } as unknown as SessionDescriptor;
  return {
    create: mock(() => stubDescriptor),
    get: mock(() => null),
    transition: mock(() => stubDescriptor),
    bindHandle: mock(() => stubDescriptor),
    resume: mock(() => null),
    runInSession: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    })),
    auditPrompt: mock(() => {}),
    ...overrides,
  } as ISessionManager;
}
