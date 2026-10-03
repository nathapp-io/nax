/** Barrel for nax-agent's test helpers: the generic ones live in @nathapp/nax-test-kit/bun (S2-0). */

export { absentValue, nullValue } from "@nathapp/nax-test-kit/bun/absent";
export { assertDefined, firstCall } from "@nathapp/nax-test-kit/bun/assert-defined";
export { withDepsRestore } from "@nathapp/nax-test-kit/bun/deps";
export type { FakeClock } from "@nathapp/nax-test-kit/bun/fake-clock";
export { makeFakeClock } from "@nathapp/nax-test-kit/bun/fake-clock";
export { waitForFile } from "@nathapp/nax-test-kit/bun/fs";
export { mockFetch } from "@nathapp/nax-test-kit/bun/mock-fetch";
export {
  type NaxParentFailure,
  type NaxParentKind,
  type NaxParentStat,
  type SessionTmpDepsLike,
  type SessionTmpHostFacts,
  stubSessionTmpDeps,
} from "@nathapp/nax-test-kit/bun/session-tmp-deps";
export type { FakeProcSpec, SpawnCall, SpawnResult, SpawnStub } from "@nathapp/nax-test-kit/bun/spawn";
export { makeSpawn, makeSpawnResult } from "@nathapp/nax-test-kit/bun/spawn";
export { cleanupTempDir, makeTempDir, withTempDir } from "@nathapp/nax-test-kit/bun/temp";
export { waitForCondition, withTimeout } from "@nathapp/nax-test-kit/bun/timeout";
export {
  type LogCall,
  type MockLogger,
  makeLogger,
  withDebugSpy,
  withInfoSpy,
  withWarnSpy,
} from "./agent-logger";
export { assertCaughtInstanceOf, assertNaxError } from "./assert-nax-error";
export {
  GUARD_HIGH_ANSWER,
  GUARD_LOW_ANSWER,
  GUARD_THRESHOLD,
  type GuardClassifyAnswer,
  type GuardFixture,
  type GuardFixtureOptions,
  IDENTIFIER_KEYS,
  type IdentifierKeysMatchContract,
  makeCommandShadowRecorder,
  makeGuardFixture,
  observedOnly,
  requireGuard,
} from "./command-safety";
export { type NativeSessionSeed, seedNativeSession } from "./native-session-state";
export { TEST_GIT_EXCLUDE_PATHSPECS, TEST_GITIGNORE_PATTERNS, testProtectedPaths } from "./protected-paths";
export { type FakeSandboxMode, makeFakeSandboxBackend } from "./sandbox";
export {
  type ConfinedSessionOptions,
  type ConfinedSessionSeam,
  NON_SHARED_TMPDIR,
  POLICY_BUILT,
  type SessionSandboxDepsLike,
  stubSessionSandboxDeps,
  withSessionSandboxSeam,
} from "./session-sandbox-deps";
export type { StubMode } from "./systemone-stub";
export { startSystemOneStub, stubAnswerBody } from "./systemone-stub";
export { type TimerSpyResult, withTimerSpy } from "./timer-spy";
