import type { NativeSessionState } from "#src/native/session/session";

export interface NativeSessionSeed {
  readonly transcriptDir: string;
  readonly owner?: string;
  readonly scratchpadRoot?: string;
  readonly timeoutSeconds?: number;
}

/** Seeds what `openNativeSession` would record, for tests that drive `runNativeTurn` directly. */
export function seedNativeSession(
  state: NativeSessionState,
  name: string,
  seed: NativeSessionSeed,
): NativeSessionState {
  state.transcriptDirs.set(name, seed.transcriptDir);
  if (seed.owner !== undefined) state.transcriptOwners.set(name, seed.owner);
  if (seed.scratchpadRoot !== undefined) state.scratchpadRoots.set(name, seed.scratchpadRoot);
  if (seed.timeoutSeconds !== undefined) state.timeouts.set(name, seed.timeoutSeconds);
  return state;
}
