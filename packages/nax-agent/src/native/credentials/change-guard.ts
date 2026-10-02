/**
 * Credential change guard (US-002).
 *
 * A running nax re-reads `~/.nax/credentials` on every LLM request, so one
 * story can be billed to two accounts with nothing in the run log to show it.
 * The guard observes each read, compares the credential's identity with the one
 * it last served, and either warns or refuses — never logging the credential
 * itself, and never comparing the volatile parts of an OAuth credential.
 *
 * `read` is the only method wrapped. `modify` and `delete` pass straight
 * through: a write is not a change of who is being billed.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "@nathapp/nax-ai";
import type { CredentialAuthConfig } from "#src/infra/index";
import { getSafeLogger, NaxError } from "#src/infra/index";
import type { AuthStamp } from "#src/session/session-types";
import { fingerprintCredential } from "./fingerprint";

/**
 * Where a credential came from, as reported by `describe`. `AuthStamp` without
 * the fingerprint — the guard computes that itself from the credential.
 */
export interface CredentialOrigin {
  source: "file" | "exec";
  account?: string;
}

export interface ChangeGuardOptions {
  /** `warn` adopts the new identity and serves it; `refuse` throws instead. */
  onChange: CredentialAuthConfig["onChange"];
  /**
   * Where the credential read from `inner` came from. Called immediately after
   * each successful read, because the credential itself carries no provenance.
   * `undefined` means the source could not be described — recorded as `file`.
   */
  describe(providerId: ProviderId): CredentialOrigin | undefined;
}

/** The credential store, with the identity of whatever it last served. */
export interface GuardedCredentialStore extends CredentialStore {
  /**
   * The last identity observed for `providerId`, or `undefined` if it was never
   * read. Updated on every read, including one that logged nothing because the
   * fingerprint was unchanged.
   */
  servedAuth(providerId: ProviderId): AuthStamp | undefined;
}

/** What a read means relative to the identity already held for that provider. */
type Verdict = "same" | "renewed" | "changed";

interface Identity {
  kind: "api-key" | "oauth";
  fingerprint: string;
  source: "file" | "exec";
  account?: string;
}

/**
 * `api-key` → `api-key`, both carrying an account label, different labels: a
 * different account is serving the same provider, whichever way the key moved.
 */
function accountLabelChanged(previous: Identity, next: Identity): boolean {
  return (
    previous.kind === "api-key" &&
    next.kind === "api-key" &&
    previous.account !== undefined &&
    next.account !== undefined &&
    previous.account !== next.account
  );
}

/**
 * Classify a read against the stored identity.
 *
 * `renewed` is the "this is routine" verdict: an OAuth refresh-token rotation,
 * which any nax process on the machine produces, or a rotating `api-key` whose
 * account label is unchanged (the exec helper hands out short-lived keys). It is
 * deliberately not a change — refusing it would break normal operation.
 */
function classify(previous: Identity, next: Identity): Verdict {
  if (accountLabelChanged(previous, next)) return "changed";
  if (previous.fingerprint === next.fingerprint) return "same";
  if (previous.kind !== next.kind) return "changed";
  if (next.kind === "oauth") return "renewed";
  if (previous.account !== undefined && next.account !== undefined) return "renewed";
  return "changed";
}

/** The identity fields every credential event carries. */
function identityData(providerId: ProviderId, identity: Identity): Record<string, unknown> {
  return {
    providerId,
    kind: identity.kind,
    source: identity.source,
    fingerprint: identity.fingerprint,
    ...(identity.account !== undefined ? { account: identity.account } : {}),
  };
}

/** The identity fields plus what it replaced — for `changed` and `renewed`. */
function replacementData(providerId: ProviderId, identity: Identity, previous: Identity): Record<string, unknown> {
  return {
    ...identityData(providerId, identity),
    previousFingerprint: previous.fingerprint,
    ...(previous.account !== undefined ? { previousAccount: previous.account } : {}),
  };
}

function toStamp(identity: Identity): AuthStamp {
  return {
    fingerprint: identity.fingerprint,
    source: identity.source,
    ...(identity.account !== undefined ? { account: identity.account } : {}),
  };
}

/**
 * Wrap `inner` in a change guard.
 *
 * The guard keeps one identity per provider for the life of the process. Under
 * `onChange: "refuse"` a changed credential is never adopted, so the provider
 * stays refused until the credential is restored — every later read refuses too,
 * which is the point: the run must not quietly continue on a different account.
 */
export function createChangeGuard(inner: CredentialStore, options: ChangeGuardOptions): GuardedCredentialStore {
  const identities = new Map<ProviderId, Identity>();

  async function read(providerId: ProviderId): Promise<StoredCredential | undefined> {
    const credential = await inner.read(providerId);
    // An absent credential says nothing about identity; leave the stored one be.
    if (credential === undefined) return undefined;

    const described = options.describe(providerId);
    const identity: Identity = {
      kind: credential.kind,
      fingerprint: await fingerprintCredential(credential),
      source: described?.source ?? "file",
      ...(described?.account !== undefined ? { account: described.account } : {}),
    };

    const previous = identities.get(providerId);
    if (previous === undefined) {
      getSafeLogger()?.info("credentials", "credential.resolved", identityData(providerId, identity));
      identities.set(providerId, identity);
      return credential;
    }

    const verdict = classify(previous, identity);
    if (verdict === "renewed") {
      getSafeLogger()?.info("credentials", "credential.renewed", replacementData(providerId, identity, previous));
    } else if (verdict === "changed") {
      getSafeLogger()?.warn("credentials", "credential.changed", {
        ...replacementData(providerId, identity, previous),
        onChange: options.onChange,
      });
      if (options.onChange === "refuse") {
        throw new NaxError(
          `[credentials] Credential for ${providerId} changed from ${previous.fingerprint} to ${identity.fingerprint}`,
          "CREDENTIAL_CHANGED",
          {
            stage: "credentials",
            providerId,
            kind: identity.kind,
            source: identity.source,
            fingerprint: identity.fingerprint,
            previousFingerprint: previous.fingerprint,
          },
        );
      }
    }

    // Adopt what this read observed even when nothing was logged: an identical
    // fingerprint can still arrive from a different source or account label, and
    // servedAuth promises the *last observed* identity, not the first. A refused
    // change never reaches here, which is what keeps the provider refused.
    identities.set(providerId, identity);
    return credential;
  }

  return {
    read,
    modify: (providerId, fn) => inner.modify(providerId, fn),
    delete: (providerId) => inner.delete(providerId),
    servedAuth: (providerId) => {
      const identity = identities.get(providerId);
      return identity === undefined ? undefined : toStamp(identity);
    },
  };
}
