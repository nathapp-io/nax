/**
 * Barrel export for test helpers. Import from here in test files:
 *
 * ```ts
 * import { makeMockAgentManager, makeNaxConfig, makeStory } from "@test/helpers";
 * ```
 *
 * See .claude/rules/test-helpers.md for usage guidelines.
 */

export { makeAgentAdapter } from "./mock-agent-adapter";
export { createMockAgentManager, makeMockAgentManager } from "./mock-agent-manager";
export { makeLogger, type LogCall, type MockLogger } from "./mock-logger";
export { makeNaxConfig, makeSparseNaxConfig, type DeepPartial } from "./mock-nax-config";
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
export { makeAgentRegistry } from "./agent-registry";
export { makeAgentResult } from "./agent-result";
export { makeContextBundle, makeContextManifest } from "./context-bundle";
export { makeEscalationContext } from "./escalation-context";
export { makePluginRegistry, type MockPluginRegistry } from "./plugin-registry";
export { makeSpawn, makeSpawnResult } from "./spawn";
export { makeDebateRunner, DEFAULT_DEBATE_RESULT, type MockDebateRunner } from "./debate-runner";
export { makeMergeEngine, type MockMergeEngine } from "./merge-engine";
export { makeStatusWriter, type MockStatusWriter } from "./status-writer";
export type { FakeProcSpec, SpawnCall, SpawnResult, SpawnStub } from "./spawn";
export { withDepsRestore } from "./deps";
export { withExecutionDeps, type ExecutionDepsOverrides } from "./execution-deps-stub";
export { waitForCondition, withTimeout } from "./timeout";
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
export { makeMutationCheckCtx, makeMutationCheckDeps } from "./mutation-check";
export type { MutationCheckCtxOptions } from "./mutation-check";
export { fullTest, fullDescribe } from "./env";
export { waitForFile } from "./fs";
export { fakeAgentManager } from "./fake-agent-manager";
export type { FakeAgentManagerOptions } from "./fake-agent-manager";
