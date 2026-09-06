/**
 * Barrel export for test helpers. Import from here in test files:
 *
 * ```ts
 * import { makeMockAgentManager, makeNaxConfig, makeStory } from "@test/helpers";
 * ```
 *
 * See .claude/rules/test-helpers.md for usage guidelines.
 */

export { absentValue, nullValue } from "./absent";
export { type AgentManagerInternals, agentManagerInternals } from "./agent-manager-internals";
export { makeAgentRegistry } from "./agent-registry";
export { makeAgentResult } from "./agent-result";
export { assertDefined, firstCall } from "./assert-defined";
export { assertCaughtInstanceOf, assertNaxError } from "./assert-nax-error";
export { makeMockCallContext } from "./call-context";
export { type CallOpStubOptions, DEFAULT_AGENT_ENVELOPE, makeCallOp } from "./call-op";
export { opSelector } from "./config-selector";
export { makeContextBundle, makeContextManifest } from "./context-bundle";
export { type MockContextOrchestrator, makeContextOrchestrator } from "./context-orchestrator";
export { DEFAULT_DEBATE_RESULT, type MockDebateRunner, makeDebateRunner } from "./debate-runner";
export { withDepsRestore } from "./deps";
export { type DispatchContextOptions, makeDispatchContext } from "./dispatch-context";
export type { E2EGates, E2EOptions, E2EResult, ScriptedAgentSpec, ScriptedTurn } from "./e2e";
export { makeScriptedAgent, runOrchestratorE2E } from "./e2e";
export { fullDescribe, fullTest } from "./env";
export { makeEscalationContext } from "./escalation-context";
export { type ExecutionDepsOverrides, withExecutionDeps } from "./execution-deps-stub";
export type { FakeAgentManagerOptions } from "./fake-agent-manager";
export { fakeAgentManager } from "./fake-agent-manager";
export type { FakeClock } from "./fake-clock";
export { makeFakeClock } from "./fake-clock";
export { makeFinding } from "./finding";
export { makeFixCycleResult, makeIteration } from "./fix-cycle-result";
export { waitForFile } from "./fs";
export { type MockInteractionChain, makeInteractionChain } from "./interaction-chain";
export {
  type CLIInternals,
  cliInternals,
  type TelegramInternals,
  telegramInternals,
  type WebhookInternals,
  webhookInternals,
} from "./interaction-internals";
export { makeLinkWithCosts } from "./link-with-costs";
export { type MockMergeEngine, makeMergeEngine } from "./merge-engine";
export { makeAgentAdapter } from "./mock-agent-adapter";
export { createMockAgentManager, makeMockAgentManager } from "./mock-agent-manager";
export { mockFetch } from "./mock-fetch";
export { type LogCall, type MockLogger, makeLogger } from "./mock-logger";
export {
  type DeepPartial,
  makeAdversarialReviewConfig,
  makeConfigSlice,
  makeNaxConfig,
  makeSemanticReviewConfig,
  makeSparseNaxConfig,
  makeStorySizeGateConfig,
} from "./mock-nax-config";
export { makeSessionManager } from "./mock-session-manager";
export { makeInProgressStory, makePendingStory, makePRD, makeStory } from "./mock-story";
export type { MutationCheckCtxOptions } from "./mutation-check";
export { makeMutationCheckCtx, makeMutationCheckDeps } from "./mutation-check";
export { opModelResolver } from "./op-model";
export { makeOptimizerResult } from "./optimizer-result";
export { DEFAULT_TEST_ROUTING, makeTestContext, makeTestPRD, makeTestStory } from "./pipeline-context";
export { makeMockPlanInputs, makeResolvedTestPatterns } from "./plan-inputs";
export { type MockPluginRegistry, makePluginRegistry } from "./plugin-registry";
export { makeAdversarialOutput, makeDiagnoseOutput, makeSemanticOutput } from "./review-outputs";
export {
  type MockRuntimeOptions,
  makeMockRuntime,
  makeRuntimeWithFakeAgent,
  makeTestRuntime,
  type TestRuntimeOptions,
} from "./runtime";
export type { FakeProcSpec, SpawnCall, SpawnResult, SpawnStub } from "./spawn";
export { makeSpawn, makeSpawnResult } from "./spawn";
export { type MockStatusWriter, makeStatusWriter } from "./status-writer";
export { cleanupTempDir, makeTempDir, withTempDir } from "./temp";
export { waitForCondition, withTimeout } from "./timeout";
export type { TimerSpyResult } from "./timer-spy";
export { withTimerSpy } from "./timer-spy";
export { makeTurnResult } from "./turn-result";
export { withDebugSpy, withInfoSpy, withWarnSpy } from "./warn-spy";
export { type MockWorktreeManager, makeWorktreeManager } from "./worktree-manager";
