/** Barrel for nax-agent's test helpers (moved from packages/nax/test/helpers by S1-5). */

export { absentValue, nullValue } from "./absent";
export { assertDefined, firstCall } from "./assert-defined";
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
export { withDepsRestore } from "./deps";
export type { FakeClock } from "./fake-clock";
export { makeFakeClock } from "./fake-clock";
export { waitForFile } from "./fs";
export { mockFetch } from "./mock-fetch";
export { type FakeSandboxMode, makeFakeSandboxBackend } from "./sandbox";
export {
  type NaxParentFailure,
  type NaxParentKind,
  type NaxParentStat,
  type SessionTmpDepsLike,
  type SessionTmpHostFacts,
  stubSessionTmpDeps,
} from "./session-tmp-deps";
export type { FakeProcSpec, SpawnCall, SpawnResult, SpawnStub } from "./spawn";
export { makeSpawn, makeSpawnResult } from "./spawn";
export type { StubMode } from "./systemone-stub";
export { startSystemOneStub, stubAnswerBody } from "./systemone-stub";
export { cleanupTempDir, makeTempDir, withTempDir } from "./temp";
export { waitForCondition, withTimeout } from "./timeout";
