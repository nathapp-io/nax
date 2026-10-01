/**
 * Exec credential source (US-003).
 *
 * Credentials can come from a helper process instead of the credential file. The
 * helper is a public contract, because koda depends on it:
 *
 *   invocation  argv `[...command, "get"]`, no shell, stdin a pipe, nax's
 *               environment inherited (as git credential helpers do)
 *   request     one JSON line on stdin, then stdin is closed:
 *               `{"version":1,"providerId":"anthropic"}`
 *   credential  exit 0, stdout `{"version":1,"kind":"api-key","key":"…",
 *               "expiresAt":…,"account":"…"}` — the last two optional
 *   decline     exit 0, stdout `{"version":1,"decline":true}` — "not mine"
 *   failure     non-zero exit, timeout, spawn error → CREDENTIAL_HELPER_FAILED
 *               a malformed reply → CREDENTIAL_HELPER_INVALID
 *
 * The wire contract lives in helper-protocol.ts, the process boundary (spawn,
 * bounded streams, both kill switches) in helper-process.ts; this module is the
 * part that caches leases, decides freshness, falls back to the last good lease,
 * and never logs the key.
 *
 * `modify` and `delete` throw: the helper owns the credential. US-003 refuses a
 * provider that switches source mid-process rather than supporting it, so a
 * decline for a provider that already holds a lease is invalid, not a fallback.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "@nathapp/nax-ai";
import { NaxError } from "@/agents/infra";
import { getSafeLogger } from "@/logger";
import type { HelperProcessResult } from "./helper-process";
import { runHelper } from "./helper-process";
import { parseReply } from "./helper-protocol";

export { AUTH_HELPER_STDERR_MAX_BYTES, AUTH_HELPER_STDOUT_MAX_BYTES } from "./helper-process";

/**
 * A lease closer to expiry than this is accepted but never fresh: the next read
 * spawns the helper again, so a run cannot be left holding a key that expires
 * mid-call. Not configurable (US-003 scope).
 */
export const LEASE_FRESHNESS_MS = 60_000;

/** Mirrors AuthConfigSchema's `auth.exec.timeoutMs` default; this module is not config-aware. */
const DEFAULT_HELPER_TIMEOUT_MS = 10_000;

type FailureCode = "CREDENTIAL_HELPER_FAILED" | "CREDENTIAL_HELPER_INVALID";

/** One cached credential. An absent `expiresAt` means "for the life of the process". */
interface Lease {
  key: string;
  expiresAt?: number;
  account?: string;
}

/** Why a helper call failed, and what the failure branch needs to report it. */
interface HelperFailure {
  code: FailureCode;
  /** Human-readable reason, for the thrown message only. */
  detail: string;
  timedOut: boolean;
  /** Redacted stderr excerpt, already truncated to AUTH_HELPER_STDERR_MAX_BYTES. */
  stderr: string;
  /** Present only when the process exited on its own; null when a signal killed it. */
  exitCode?: number;
  cause?: unknown;
}

type HelperOutcome =
  | { kind: "credential"; lease: Lease }
  | { kind: "decline" }
  | { kind: "failure"; failure: HelperFailure };

export interface ExecCredentialSourceOptions {
  /** The helper executable, plus any leading argv. `"get"` is appended per call. */
  readonly command: readonly string[];
  /** Hard deadline for one helper call. Defaults to the config schema's 10s. */
  readonly timeoutMs?: number;
  /** Clock for lease expiry. Defaults to `Date.now`; tests inject one instead of waiting out a lease. */
  readonly now?: () => number;
}

/**
 * The exec source as the store seam sees it. `accountOf` exposes the current
 * lease's non-secret account label separately, because `read` may only return
 * the `{ kind, key }` shape nax-ai's `StoredCredential` allows.
 */
export interface ExecCredentialSource extends CredentialStore {
  accountOf(providerId: ProviderId): string | undefined;
}

/** A failure outcome, with the code it is reported under. */
function failureOf(code: FailureCode, parts: Omit<HelperFailure, "code">): HelperOutcome {
  return { kind: "failure", failure: { code, ...parts } };
}

/**
 * Translate what the process boundary saw into a helper outcome.
 *
 * The two kill switches do not share a code: a deadline that passed is a failed
 * helper, while stdout past its cap is a malformed reply. Both killed the
 * process, so its own exit code is not the verdict in either case.
 */
function outcomeOf(result: HelperProcessResult): HelperOutcome {
  switch (result.kind) {
    case "spawn-failed":
      return failureOf("CREDENTIAL_HELPER_FAILED", {
        detail: result.detail,
        timedOut: false,
        stderr: result.stderr,
        cause: result.cause,
      });
    case "no-answer":
      return failureOf("CREDENTIAL_HELPER_FAILED", {
        detail: result.detail,
        timedOut: false,
        stderr: result.stderr,
      });
    case "timed-out":
      return failureOf("CREDENTIAL_HELPER_FAILED", { detail: result.detail, timedOut: true, stderr: result.stderr });
    case "stdout-over-cap":
      return failureOf("CREDENTIAL_HELPER_INVALID", {
        detail: result.detail,
        timedOut: false,
        stderr: result.stderr,
      });
    case "exited": {
      if (result.exitCode !== 0) {
        return failureOf("CREDENTIAL_HELPER_FAILED", {
          detail: `exited with code ${result.exitCode}`,
          timedOut: false,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
      const reply = parseReply(result.stdout);
      if (reply.kind === "invalid") {
        return failureOf("CREDENTIAL_HELPER_INVALID", {
          detail: reply.detail,
          timedOut: false,
          stderr: result.stderr,
        });
      }
      return reply;
    }
  }
}

/** The message a thrown helper failure carries. */
function failureMessage(providerId: ProviderId, failure: HelperFailure): string {
  return `[credentials] The credential helper for ${providerId} ${failure.detail}`;
}

export function createExecCredentialSource(options: ExecCredentialSourceOptions): ExecCredentialSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  /** The lease in force: what a fresh read is served from. */
  const leases = new Map<ProviderId, Lease>();
  /** The last credential the helper handed out, kept for the failure branch. */
  const lastGood = new Map<ProviderId, Lease>();
  /** Providers this process has already heard a decline for. */
  const declined = new Set<ProviderId>();
  /** The helper call already running per provider — single-flight. */
  const inFlight = new Map<ProviderId, Promise<StoredCredential | undefined>>();
  /** Providers whose current consecutive-failure streak has already been logged. */
  const failureLogged = new Set<ProviderId>();

  /** Only the two fields nax-ai's StoredCredential allows; the account label travels separately. */
  function credentialOf(lease: Lease): StoredCredential {
    return { kind: "api-key", key: lease.key };
  }

  function isFresh(lease: Lease, now: number): boolean {
    return lease.expiresAt === undefined || lease.expiresAt - now > LEASE_FRESHNESS_MS;
  }

  /**
   * The last good lease, only while it has not expired. A helper that has gone
   * away mid-run must not leave every request using a key the provider rejects.
   */
  function servedLastGood(providerId: ProviderId, now: number): Lease | undefined {
    const lease = lastGood.get(providerId);
    return lease?.expiresAt !== undefined && lease.expiresAt > now ? lease : undefined;
  }

  /**
   * The failure branch. `credential.helper_failed` is logged once per
   * consecutive-failure streak — a helper that keeps failing must not fill the
   * run log, and the streak resets on the next credential it serves.
   */
  function handleFailure(providerId: ProviderId, failure: HelperFailure): StoredCredential {
    const fallback = servedLastGood(providerId, now());
    if (!failureLogged.has(providerId)) {
      failureLogged.add(providerId);
      getSafeLogger()?.warn("credentials", "credential.helper_failed", {
        providerId,
        code: failure.code,
        ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
        timedOut: failure.timedOut,
        stderr: failure.stderr,
        servedLastGood: fallback !== undefined,
      });
    }

    if (fallback !== undefined) return credentialOf(fallback);
    throw new NaxError(failureMessage(providerId, failure), failure.code, {
      stage: "credentials",
      providerId,
      timedOut: failure.timedOut,
      ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
      ...(failure.cause !== undefined ? { cause: failure.cause } : {}),
    });
  }

  /** Apply one helper outcome to the provider's state. */
  function applyOutcome(providerId: ProviderId, outcome: HelperOutcome): StoredCredential | undefined {
    if (outcome.kind === "failure") return handleFailure(providerId, outcome.failure);

    if (outcome.kind === "decline") {
      // A provider never switches source mid-process: once it holds a lease, a
      // decline is a contradiction, not a fallback to the file.
      if (leases.has(providerId)) {
        return handleFailure(providerId, {
          code: "CREDENTIAL_HELPER_INVALID",
          detail: "declined for a provider that already holds a lease",
          timedOut: false,
          stderr: "",
        });
      }
      declined.add(providerId);
      return undefined;
    }

    leases.set(providerId, outcome.lease);
    lastGood.set(providerId, outcome.lease);
    failureLogged.delete(providerId);
    return credentialOf(outcome.lease);
  }

  async function callHelper(providerId: ProviderId): Promise<StoredCredential | undefined> {
    return applyOutcome(providerId, outcomeOf(await runHelper(options.command, providerId, timeoutMs)));
  }

  async function read(providerId: ProviderId): Promise<StoredCredential | undefined> {
    // 1. A decline this process already heard: the helper is not this
    //    provider's source, and asking again would only spawn it anew.
    if (declined.has(providerId)) return undefined;

    // 2. A fresh lease, without spawning. A lease with no expiry never goes
    //    stale, so the helper runs once per process for that provider.
    const lease = leases.get(providerId);
    if (lease !== undefined && isFresh(lease, now())) return credentialOf(lease);

    // 3. Single-flight: a second read for the same provider joins the call
    //    already running instead of spawning a second helper.
    const running = inFlight.get(providerId);
    if (running !== undefined) return running;

    // 4. Spawn. The map is set before the first await, so a concurrent read
    //    cannot miss it.
    const pending = callHelper(providerId);
    inFlight.set(providerId, pending);
    try {
      return await pending;
    } finally {
      if (inFlight.get(providerId) === pending) inFlight.delete(providerId);
    }
  }

  function managedByHelper(providerId: ProviderId, operation: "modify" | "delete"): NaxError {
    return new NaxError(
      `[credentials] Cannot ${operation} the credential for ${providerId}: the exec helper owns it.`,
      "CREDENTIAL_MANAGED_BY_HELPER",
      { stage: "credentials", providerId, operation },
    );
  }

  return {
    read,
    // Synchronous throws, not rejections: the helper owns the credential, so the
    // refusal is the whole answer and no work is done — a caller holding only
    // the returned promise would otherwise see an unhandled rejection.
    modify(providerId: ProviderId): Promise<StoredCredential | undefined> {
      throw managedByHelper(providerId, "modify");
    },
    delete(providerId: ProviderId): Promise<void> {
      throw managedByHelper(providerId, "delete");
    },
    accountOf: (providerId) => leases.get(providerId)?.account,
  };
}
