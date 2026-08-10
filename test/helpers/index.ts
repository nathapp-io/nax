/**
 * Barrel export for test helpers. Import from here in test files:
 *
 * ```ts
 * import { makeMockAgentManager, makeNaxConfig, makeStory } from "../../helpers";
 * ```
 *
 * See .claude/rules/test-helpers.md for usage guidelines.
 */

export { makeAgentAdapter } from "./mock-agent-adapter";
export { createMockAgentManager, makeMockAgentManager } from "./mock-agent-manager";
export { makeLogger, type LogCall, type MockLogger } from "./mock-logger";
export { makeNaxConfig, makeSparseNaxConfig } from "./mock-nax-config";
export { makeSessionManager } from "./mock-session-manager";
export {
  makeMockRuntime,
  makeRuntimeWithFakeAgent,
  makeTestRuntime,
  type MockRuntimeOptions,
  type TestRuntimeOptions,
} from "./runtime";
export { makeInProgressStory, makePRD, makePendingStory, makeStory } from "./mock-story";
export { cleanupTempDir, makeTempDir, withTempDir } from "./temp";
export {
  agentManagerWithFixedLLMResponse,
  captureAuditDecisions,
  makeSpawnMock,
  mockDiffUtilsDeps,
} from "./review-audit";
export { withDepsRestore } from "./deps";
export { waitForCondition } from "./timeout";
export { makeLinkWithCosts } from "./link-with-costs";
export { makeMockCallContext } from "./call-context";
export { makeMockPlanInputs } from "./plan-inputs";
export { withWarnSpy, withInfoSpy } from "./warn-spy";
export { withTimerSpy } from "./timer-spy";
export type { TimerSpyResult } from "./timer-spy";
export { makeFakeClock } from "./fake-clock";
export type { FakeClock } from "./fake-clock";
export { mockFetch } from "./mock-fetch";
export { makeScriptedAgent, runOrchestratorE2E } from "./e2e";
export type { ScriptedAgentSpec, ScriptedTurn, E2EOptions, E2EResult, E2EGates } from "./e2e";
export { DEFAULT_TEST_ROUTING, makeTestContext, makeTestPRD, makeTestStory } from "./pipeline-context";
export { makeFlowCtx, makeFlowStep, makeFlowSteps, reviewRounds } from "./flow-steps";
export { makeMutationCheckCtx, makeMutationCheckDeps } from "./mutation-check";
export type { MutationCheckCtxOptions } from "./mutation-check";
