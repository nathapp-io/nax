/**
 * The chained credential store (US-004).
 *
 * nax-ai's file store re-reads `~/.nax/credentials` on every read, so a silent
 * mid-run change can split billing across accounts. This is the seam that
 * decides which source serves a provider — the exec helper first when one is
 * configured, the file store otherwise — and remembers, per provider, which one
 * answered.
 *
 * The memory matters because a provider the helper served is the helper's to
 * manage: writing it to the file store would split one credential across two
 * stores, and OAuth refresh must keep going through the file store so its
 * cross-process lock and write-back still apply.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import type { ExecCredentialSource } from "./exec-source";

/** The store the run is assembled around: a chain, plus where each provider came from. */
export interface ChainedCredentialStore extends CredentialStore {
  /** Which store last served `providerId`, or `undefined` if it was never read. */
  sourceOf(providerId: ProviderId): "exec" | "file" | undefined;
  /** The account label the exec source reported for `providerId`, if it served it. */
  accountOf(providerId: ProviderId): string | undefined;
}

export interface ChainedCredentialStoreOptions {
  /** Tried first, when configured. A decline falls through to the file store. */
  readonly exec?: ExecCredentialSource;
  /** The store `~/.nax/credentials` back, and the only one that can be written. */
  readonly file: CredentialStore;
}

export function createChainedCredentialStore(options: ChainedCredentialStoreOptions): ChainedCredentialStore {
  /** Providers this process has read, and the source that answered. */
  const served = new Map<ProviderId, "exec" | "file">();

  /** The refusal for a write against a provider the helper owns. */
  function managedByHelper(providerId: ProviderId, operation: "modify" | "delete"): NaxError {
    return new NaxError(
      `[credentials] Cannot ${operation} the credential for ${providerId}: the exec helper owns it.`,
      "CREDENTIAL_MANAGED_BY_HELPER",
      { stage: "credentials", providerId, operation },
    );
  }

  /** Read the file store, reporting a failure under one code. */
  async function readFileStore(providerId: ProviderId): Promise<StoredCredential | undefined> {
    try {
      return await options.file.read(providerId);
    } catch (cause) {
      const error = new NaxError(
        `[credentials] The credential file could not be read for ${providerId}.`,
        "CREDENTIAL_FILE_UNREADABLE",
        { stage: "credentials", providerId, cause },
      );
      // Also on the error itself: `context.cause` is where nax puts a cause, and
      // `Error.cause` is what a generic cause-chain walk (nax-ai's ProtocolError,
      // the credential-fault classifier) reads. Both spellings, one error.
      error.cause = cause;
      throw error;
    }
  }

  return {
    async read(providerId: ProviderId): Promise<StoredCredential | undefined> {
      if (options.exec !== undefined) {
        const credential = await options.exec.read(providerId);
        if (credential !== undefined) {
          served.set(providerId, "exec");
          return credential;
        }
      }
      const credential = await readFileStore(providerId);
      // Recorded even when the file store held nothing: the decline is what
      // makes the file store this provider's source for the process's lifetime.
      served.set(providerId, "file");
      return credential;
    },
    // Both refusals are synchronous throws, not rejections: the store is asked
    // to write and answers "no" without doing anything, and a caller that only
    // holds the returned promise would otherwise see an unhandled rejection.
    modify(providerId, fn) {
      if (served.get(providerId) === "exec") throw managedByHelper(providerId, "modify");
      return options.file.modify(providerId, fn);
    },
    delete(providerId) {
      if (served.get(providerId) === "exec") throw managedByHelper(providerId, "delete");
      return options.file.delete(providerId);
    },
    sourceOf: (providerId) => served.get(providerId),
    accountOf: (providerId) => (served.get(providerId) === "exec" ? options.exec?.accountOf(providerId) : undefined),
  };
}
