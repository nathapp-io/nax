/**
 * Seams and small helpers shared by the native session adapter and
 * `nativeComplete` (S1 port 2). `_adapterDeps` is the test seam the adapter
 * tests patch; both callers read it from here, so one patch reaches both.
 */

import type { AuthStamp } from "#src/session/session-types";
import { anyAmbientCredential, listStoredProviders } from "./auth.ts";
import { authSourceIsExec, servedAuth } from "./credentials/index.ts";

export function isProtocolStreamError(err: unknown): err is { protocolError: { kind: string; message: string } } {
  return typeof err === "object" && err !== null && "protocolError" in err;
}

/** Test seam, following the _clientDeps precedent. */
export const _adapterDeps = {
  listStoredProviders,
  anyAmbientCredential,
  /**
   * US-004: whether the global auth config points at an exec helper. Injectable
   * so a test can pin the credential-source decision without writing
   * `~/.nax/config.json`.
   */
  authSourceIsExec,
  /** US-006: the identity the store observed for a provider — injectable like its siblings. */
  servedAuth,
  /**
   * Injectable timer pair — lets the whole-turn deadline test (US-002 AC12)
   * drive the abort off a virtual clock instead of waiting the schema
   * minimum. Mirrors `_heartbeatDeps` / `_idleWatchdogDeps` / `_authDeps`.
   *
   * @internal
   */
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
};

/**
 * US-006: `{ auth }` for the identity the credential store observed for
 * `provider`, `{}` otherwise — so the key stays absent, never `undefined`. A
 * helper because `sendTurn` cannot carry another branch on the complexity
 * ratchet; it reads the `_adapterDeps` seam so a unit test can pin the stamp
 * without assembling a real store.
 */
export function authFields(provider: string): { auth?: AuthStamp } {
  const auth = _adapterDeps.servedAuth(provider);
  return auth === undefined ? {} : { auth };
}
