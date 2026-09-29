/**
 * Exec credential source (US-003).
 *
 * Credentials can come from a helper process instead of the credential file.
 * The helper is a public contract, because koda depends on it:
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
 * The key travels over stdout only, never argv or environment, and stdout is
 * never logged. stderr is redacted *before* it is truncated, so truncation can
 * never cut a secret into a fragment the redaction patterns no longer recognise.
 *
 * `modify` and `delete` throw: the helper owns the credential. US-003 refuses a
 * provider that switches source mid-process rather than supporting it, so a
 * decline for a provider that already holds a lease is invalid, not a fallback.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import { getSafeLogger, redactSecrets } from "@/logger";
import { errorMessage } from "@/utils/errors";

/**
 * A lease closer to expiry than this is accepted but never fresh: the next read
 * spawns the helper again, so a run cannot be left holding a key that expires
 * mid-call. Not configurable (US-003 scope).
 */
export const LEASE_FRESHNESS_MS = 60_000;

/** Hard cap on the helper's stdout. Over it the reply is malformed and the process is killed. */
export const AUTH_HELPER_STDOUT_MAX_BYTES = 65_536;

/** Hard cap on the stderr excerpt that may reach a log line or an error message. */
export const AUTH_HELPER_STDERR_MAX_BYTES = 4_096;

/**
 * How much stderr is collected before further bytes are dropped. Redaction runs
 * over the whole collected prefix and only AUTH_HELPER_STDERR_MAX_BYTES of the
 * result is kept, so the 8× margin leaves a secret that straddles the
 * truncation point fully visible to the redaction patterns.
 */
const AUTH_HELPER_STDERR_COLLECT_MAX_BYTES = AUTH_HELPER_STDERR_MAX_BYTES * 8;

/** Mirrors AuthConfigSchema's `auth.exec.timeoutMs` default; this module is not config-aware. */
const DEFAULT_HELPER_TIMEOUT_MS = 10_000;

/** The subcommand appended to the configured command. */
const HELPER_SUBCOMMAND = "get";

/** The request/reply protocol version this source speaks. */
const REQUEST_VERSION = 1;

const MAX_KEY_CHARS = 8_192;
const MAX_ACCOUNT_CHARS = 200;

/** Log stage, matching the rest of the credential subsystem. */
const LOG_STAGE = "credentials";

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

/** The slice of Bun's Subprocess this source uses. */
interface HelperProcess {
  readonly stdin: { write(data: string): unknown; end(): unknown };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  /**
   * Always SIGKILL. A deadline that a helper can ignore is not a deadline: the
   * call would wait on a process that never exits, and `read` would never
   * settle.
   */
  kill(signal: "SIGKILL"): void;
}

/**
 * Injectable seam (the `_deps` pattern): every external call this module makes
 * goes through it, so a test can drive the helper without a real process.
 *
 * The spawn deliberately passes no `env`: the child inherits nax's environment,
 * which is what the helper contract promises.
 */
export const _execSourceDeps = {
  spawn: (argv: readonly string[]): HelperProcess =>
    // nax-git-env-allow: caller-supplied helper argv, not git; the child inherits nax's env by contract
    Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as HelperProcess,
  /**
   * Timer pair, wrapped so the global functions are resolved per call — a test
   * that spies on `setTimeout` (the timer-leak helper) still sees these.
   */
  setTimeout: ((fn: () => void, ms: number): unknown => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
};

export interface ExecCredentialSourceOptions {
  /** The helper executable, plus any leading argv. `"get"` is appended per call. */
  readonly command: readonly string[];
  /** Hard deadline for one helper call. Defaults to the config schema's 10s. */
  readonly timeoutMs?: number;
}

/**
 * The exec source as the store seam sees it. `accountOf` exposes the current
 * lease's non-secret account label separately, because `read` may only return
 * the `{ kind, key }` shape nax-ai's `StoredCredential` allows.
 */
export interface ExecCredentialSource extends CredentialStore {
  accountOf(providerId: ProviderId): string | undefined;
}

/** Bytes read from a stream, and whether its cap was passed while reading it. */
interface StreamRead {
  text: string;
  exceeded: boolean;
}

/**
 * A failure outcome, minus the stderr excerpt every call site has to hand back.
 */
function failureOf(code: FailureCode, parts: Omit<HelperFailure, "code">): HelperOutcome {
  return { kind: "failure", failure: { code, ...parts } };
}

/**
 * Read a stream to EOF, decoding UTF-8.
 *
 * Reads run concurrently with the exit wait: a child that fills the OS pipe
 * buffer before anyone reads it would otherwise block on its own write and never
 * reach `exited`, which would leave the timeout as the only way out.
 *
 * Past `cap` the two callers differ. With `onExceeded` the stream is abandoned —
 * the callback kills the process, so there is nothing left to drain. Without it
 * the stream is still drained (a full pipe must not wedge the child) but nothing
 * more is kept.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  cap: number,
  onExceeded?: () => void,
): Promise<StreamRead> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let exceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done === true) break;
      if (value === undefined) continue;

      bytes += value.byteLength;
      if (bytes > cap && !exceeded) {
        exceeded = true;
        if (onExceeded !== undefined) {
          onExceeded();
          // The process is dying; do not wait for its pipe to notice.
          await reader.cancel().catch(() => {});
          break;
        }
      }
      if (!exceeded) text += decoder.decode(value, { stream: true });
    }
  } catch {
    // The pipe closed under us — a kill, or a child that exited mid-write.
    // Whatever was collected before that still stands.
  }
  if (!exceeded) text += decoder.decode();
  return { text, exceeded };
}

/** Write the one-line request, then close stdin so the helper sees EOF. */
function writeRequest(proc: HelperProcess, providerId: ProviderId): void {
  try {
    proc.stdin.write(`${JSON.stringify({ version: REQUEST_VERSION, providerId })}\n`);
    proc.stdin.end();
  } catch (cause) {
    // A helper that exits without draining stdin surfaces EPIPE here. Its exit
    // code is the verdict, so this is a diagnostic, not a failure of its own.
    getSafeLogger()?.debug(LOG_STAGE, "credential.helper_stdin_failed", { providerId, error: errorMessage(cause) });
  }
}

/** Validate one credential or decline reply. Malformed → CREDENTIAL_HELPER_INVALID. */
function parseReply(stdout: string, stderr: string): HelperOutcome {
  const invalid = (detail: string): HelperOutcome =>
    failureOf("CREDENTIAL_HELPER_INVALID", { detail, timedOut: false, stderr });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    return invalid(`stdout was not JSON: ${errorMessage(cause)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("the reply was not a JSON object");
  }

  const reply = parsed as Record<string, unknown>;
  if (reply.version !== REQUEST_VERSION) {
    return invalid(`version was ${JSON.stringify(reply.version)}, expected ${REQUEST_VERSION}`);
  }
  // The decline reply carries no kind, so it is recognised before the credential
  // fields are required.
  if (reply.decline === true) return { kind: "decline" };

  if (reply.kind !== "api-key") return invalid(`kind was ${JSON.stringify(reply.kind)}, expected "api-key"`);

  const key = reply.key;
  if (typeof key !== "string" || key.length === 0) return invalid("the reply carried no key");
  if (key.length > MAX_KEY_CHARS) return invalid(`the key was longer than ${MAX_KEY_CHARS} characters`);

  const account = reply.account;
  if (account !== undefined && (typeof account !== "string" || account.length > MAX_ACCOUNT_CHARS)) {
    return invalid(`the account label was not a string of at most ${MAX_ACCOUNT_CHARS} characters`);
  }

  const expiresAt = reply.expiresAt;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      return invalid("expiresAt was not a positive integer");
    }
    if (expiresAt < Date.now()) return invalid("expiresAt was already past on receipt");
  }

  return {
    kind: "credential",
    lease: {
      key,
      ...(typeof account === "string" ? { account } : {}),
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
    },
  };
}

/**
 * Classify what came back. `trip` says which of the two kill switches fired
 * first, and it decides the code: the timeout fails, the stdout cap is a
 * malformed reply. Both killed the process, so its own exit code is not the
 * verdict in either case.
 */
function classifyProcess(
  trip: "timeout" | "cap" | undefined,
  exitCode: number | null,
  stdout: StreamRead,
  stderr: string,
  timeoutMs: number,
): HelperOutcome {
  if (trip === "cap") {
    return failureOf("CREDENTIAL_HELPER_INVALID", {
      detail: `wrote more than ${AUTH_HELPER_STDOUT_MAX_BYTES} bytes to stdout`,
      timedOut: false,
      stderr,
    });
  }
  if (trip === "timeout") {
    return failureOf("CREDENTIAL_HELPER_FAILED", {
      detail: `did not answer within ${timeoutMs}ms`,
      timedOut: true,
      stderr,
    });
  }
  if (exitCode !== 0) {
    return failureOf("CREDENTIAL_HELPER_FAILED", {
      detail: exitCode === null ? "was killed before it could answer" : `exited with code ${exitCode}`,
      timedOut: false,
      stderr,
      ...(exitCode !== null ? { exitCode } : {}),
    });
  }
  return parseReply(stdout.text, stderr);
}

/** Everything one helper process produced, before it is interpreted. */
interface ProcessRun {
  /** Which kill switch fired first, if either did. */
  trip: "timeout" | "cap" | undefined;
  /** `null` when a signal killed the process, so there is no exit code to report. */
  exitCode: number | null;
  stdout: StreamRead;
  /** Raw stderr; the caller redacts it before it reaches a log line. */
  stderr: string;
}

/** Run one helper process to its end, killing it if either kill switch trips first. */
async function runHelperProcess(proc: HelperProcess, providerId: ProviderId, timeoutMs: number): Promise<ProcessRun> {
  /** Kill without letting a race with an already-reaped child escape a timer callback. */
  const kill = (): void => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // The child was already gone; its exit code decides the outcome either way.
    }
  };

  // Whichever trips first decides the code; both kill the process.
  let trip: "timeout" | "cap" | undefined;
  const timer = _execSourceDeps.setTimeout(() => {
    if (trip === undefined) trip = "timeout";
    kill();
  }, timeoutMs);

  try {
    writeRequest(proc, providerId);
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, AUTH_HELPER_STDOUT_MAX_BYTES, () => {
        if (trip === undefined) trip = "cap";
        kill();
      }),
      readCapped(proc.stderr, AUTH_HELPER_STDERR_COLLECT_MAX_BYTES),
      proc.exited,
    ]);
    return { trip, exitCode: proc.exitCode, stdout, stderr: stderr.text };
  } finally {
    // Cleared however the call ends, including the timeout: a timer left armed
    // holds the event loop open after the read has already resolved.
    _execSourceDeps.clearTimeout(timer);
  }
}

/** Spawn the helper for `providerId` and classify its reply. Never throws for a helper failure. */
async function invokeHelper(
  options: ExecCredentialSourceOptions,
  providerId: ProviderId,
  timeoutMs: number,
): Promise<HelperOutcome> {
  let proc: HelperProcess;
  try {
    // nax-git-env-allow: caller-supplied helper argv, not git; the child inherits nax's env by contract
    proc = _execSourceDeps.spawn([...options.command, HELPER_SUBCOMMAND]);
  } catch (cause) {
    // A missing binary never reaches `exited`: Bun throws ENOENT from spawn.
    return failureOf("CREDENTIAL_HELPER_FAILED", {
      detail: `could not be started: ${errorMessage(cause)}`,
      timedOut: false,
      stderr: "",
      cause,
    });
  }

  let run: ProcessRun;
  try {
    run = await runHelperProcess(proc, providerId, timeoutMs);
  } catch (cause) {
    // The streams or the exit wait failed under us. Nothing was learned about
    // the provider, and the helper is dead either way.
    return failureOf("CREDENTIAL_HELPER_FAILED", {
      detail: `could not be read: ${errorMessage(cause)}`,
      timedOut: false,
      stderr: "",
      cause,
    });
  }

  // Redact first, truncate second. The other order can cut a secret in half and
  // leave a fragment no redaction pattern can recognise.
  const stderr = redactSecrets(run.stderr).slice(0, AUTH_HELPER_STDERR_MAX_BYTES);
  return classifyProcess(run.trip, run.exitCode, run.stdout, stderr, timeoutMs);
}

/** The message a thrown helper failure carries. */
function failureMessage(providerId: ProviderId, failure: HelperFailure): string {
  return `[${LOG_STAGE}] The credential helper for ${providerId} ${failure.detail}`;
}

export function createExecCredentialSource(options: ExecCredentialSourceOptions): ExecCredentialSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;

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
    const fallback = servedLastGood(providerId, Date.now());
    if (!failureLogged.has(providerId)) {
      failureLogged.add(providerId);
      getSafeLogger()?.warn(LOG_STAGE, "credential.helper_failed", {
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
      stage: LOG_STAGE,
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
    return applyOutcome(providerId, await invokeHelper(options, providerId, timeoutMs));
  }

  async function read(providerId: ProviderId): Promise<StoredCredential | undefined> {
    // 1. A decline this process already heard: the helper is not this
    //    provider's source, and asking again would only spawn it anew.
    if (declined.has(providerId)) return undefined;

    // 2. A fresh lease, without spawning. A lease with no expiry never goes
    //    stale, so the helper runs once per process for that provider.
    const lease = leases.get(providerId);
    if (lease !== undefined && isFresh(lease, Date.now())) return credentialOf(lease);

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
      `[${LOG_STAGE}] Cannot ${operation} the credential for ${providerId}: the exec helper owns it.`,
      "CREDENTIAL_MANAGED_BY_HELPER",
      { stage: LOG_STAGE, providerId, operation },
    );
  }

  return {
    read,
    async modify(providerId: ProviderId): Promise<StoredCredential | undefined> {
      throw managedByHelper(providerId, "modify");
    },
    async delete(providerId: ProviderId): Promise<void> {
      throw managedByHelper(providerId, "delete");
    },
    accountOf: (providerId) => leases.get(providerId)?.account,
  };
}
