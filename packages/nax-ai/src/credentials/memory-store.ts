/**
 * A CredentialStore held in memory, for tests and for callers that deliberately
 * keep credentials off disk.
 *
 * It exists because every consumer testing against nax-ai otherwise writes the
 * same fake, and the easy version of that fake is wrong: `modify` is async, so
 * two concurrent callers both observe the pre-update value and the later write
 * discards the earlier. That is the same lost update the file store takes a
 * lock to prevent, and a consumer testing against a store without it would not
 * see a bug their production store has.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "../types.ts";

export function createMemoryCredentialStore(
  initial: Readonly<Record<ProviderId, StoredCredential>> = {},
): CredentialStore {
  // Copied, so a caller's seed object is never written back into, and replaced
  // wholesale on write rather than mutated in place.
  let credentials: Readonly<Record<ProviderId, StoredCredential>> = { ...initial };

  /**
   * The in-process counterpart of the file store's lock: each modify waits for
   * the previous one to settle. `catch(() => {})` keeps the chain alive when a
   * callback throws — the rejection is still delivered to that caller, but a
   * failed refresh must not deadlock every later one.
   */
  let queue: Promise<unknown> = Promise.resolve();

  function serialise<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  }

  return {
    async read(providerId: ProviderId): Promise<StoredCredential | undefined> {
      return credentials[providerId];
    },

    async modify(
      providerId: ProviderId,
      fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
    ): Promise<StoredCredential | undefined> {
      return serialise(async () => {
        const next = await fn(credentials[providerId]);
        credentials =
          next === undefined
            ? Object.fromEntries(Object.entries(credentials).filter(([id]) => id !== providerId))
            : { ...credentials, [providerId]: next };
        return next;
      });
    },

    async delete(providerId: ProviderId): Promise<void> {
      await this.modify(providerId, async () => undefined);
    },
  };
}
