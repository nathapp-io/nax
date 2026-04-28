/**
 * ACP session lifecycle helpers — abort utilities, session management, session
 * naming, and injectable dependencies. Extracted from adapter.ts.
 */

import { createHash } from "node:crypto";
import type { ModelDef } from "../../config/schema";
import { getSafeLogger } from "../../logger";
import type { ProtocolIds } from "../../runtime/protocol-types";
import { sleep, which } from "../../utils/bun-deps";
import type { SessionHandle } from "../types";
import type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter-session-types";
import { parseAgentError } from "./parse-agent-error";
import { createSpawnAcpClient } from "./spawn-client";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable dependencies
// ─────────────────────────────────────────────────────────────────────────────

export const _acpAdapterDeps = {
  which,

  sleep,

  /**
   * Create an ACP client for the given command string.
   * Default: spawn-based client (shells out to acpx CLI).
   * Override in tests via: _acpAdapterDeps.createClient = mock(...)
   */
  createClient(
    cmdStr: string,
    cwd: string,
    timeoutSeconds?: number,
    onPidSpawned?: (pid: number) => void,
    promptRetries?: number,
  ): AcpClient {
    return createSpawnAcpClient(cmdStr, cwd, timeoutSeconds, onPidSpawned, promptRetries);
  },
};

/**
 * Injectable dependencies for the fallback retry loop in complete() and run().
 * Override in tests to mock parseAgentError and sleep.
 *
 * Fallback logging uses getSafeLogger() with stage 'agent-fallback'.
 * Log data always has storyId as the first key, followed by
 * originalAgent, fallbackAgent, errorType, and retryCount (AC6).
 * Unit tests for this interface are in:
 *   test/unit/agents/acp/adapter-fallback-logging.test.ts
 */
export const _fallbackDeps = {
  parseAgentError,
  sleep,
};

// ─────────────────────────────────────────────────────────────────────────────
// Abort helpers
// ─────────────────────────────────────────────────────────────────────────────

function createAbortError(signal?: AbortSignal, fallback = "Run aborted"): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason.length > 0) {
    return new Error(reason);
  }
  return new Error(fallback);
}

export function throwIfAborted(signal?: AbortSignal, fallback?: string): void {
  if (signal?.aborted) {
    throw createAbortError(signal, fallback);
  }
}

export async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, fallback?: string): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw createAbortError(signal, fallback);
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError(signal, fallback));
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Session naming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic ACP session handle.
 *
 * Format: nax-<gitRootHash8>-<featureName>-<storyId>[-<sessionRole>]
 *
 * The workdir hash (first 8 chars of SHA-256) prevents cross-repo and
 * cross-worktree session name collisions. Each git worktree has a distinct
 * root path, so different worktrees of the same repo get different hashes.
 */
export function computeAcpHandle(
  workdir: string,
  featureName?: string,
  storyId?: string,
  sessionRole?: string,
): string {
  const hash = createHash("sha256").update(workdir).digest("hex").slice(0, 8);
  const sanitize = (s: string) =>
    s
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "");

  const parts = ["nax", hash];
  if (featureName) parts.push(sanitize(featureName));
  if (storyId) parts.push(sanitize(storyId));
  if (sessionRole) parts.push(sanitize(sessionRole));
  return parts.join("-");
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure an ACP session exists: try to resume via loadSession, fall back to
 * createSession. Returns the AcpSession ready for prompt() calls.
 */
export async function ensureAcpSession(
  client: AcpClient,
  sessionName: string,
  agentName: string,
  permissionMode: string,
): Promise<{ session: AcpSession; resumed: boolean }> {
  if (!agentName) {
    throw new Error("[acp-adapter] agentName is required for ensureAcpSession");
  }

  if (client.loadSession) {
    try {
      const existing = await client.loadSession(sessionName, agentName, permissionMode);
      if (existing) {
        getSafeLogger()?.debug("acp-adapter", `Resumed existing session: ${sessionName}`);
        return { session: existing, resumed: true };
      }
    } catch {
      // loadSession failed — fall through to createSession
    }
  }

  getSafeLogger()?.debug("acp-adapter", `Creating new session: ${sessionName}`);
  return { session: await client.createSession({ agentName, permissionMode, sessionName }), resumed: false };
}

/**
 * Send a prompt turn to the session with timeout.
 * If the timeout fires, attempts to cancel the active prompt and returns timedOut=true.
 */
export async function runSessionPrompt(
  session: AcpSession,
  prompt: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ response: AcpSessionResponse | null; timedOut: boolean; aborted: boolean }> {
  throwIfAborted(signal, "Run aborted — shutdown in progress");
  const promptPromise = session.prompt(prompt);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  let abortHandler: (() => void) | undefined;
  const abortPromise = signal
    ? new Promise<"aborted">((resolve) => {
        abortHandler = () => resolve("aborted");
        signal.addEventListener("abort", abortHandler, { once: true });
      })
    : null;

  let winner: AcpSessionResponse | "timeout" | "aborted";
  try {
    winner = await Promise.race([promptPromise, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    clearTimeout(timeoutId);
    if (signal && abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }

  if (winner === "timeout" || winner === "aborted") {
    // Suppress the pending prompt rejection to prevent unhandled rejection after
    // cancelActivePrompt kills the acpx process (which causes an EPIPE rejection).
    promptPromise.catch(() => {});
    try {
      await session.cancelActivePrompt();
    } catch {
      await session.close().catch(() => {});
    }
    return { response: null, timedOut: winner === "timeout", aborted: winner === "aborted" };
  }

  return { response: winner as AcpSessionResponse, timedOut: false, aborted: false };
}

/**
 * Close an ACP session — best-effort, swallows errors.
 */
export async function closeAcpSession(session: AcpSession): Promise<void> {
  try {
    await session.close();
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to close session", { error: String(err) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SessionHandle implementation
// ─────────────────────────────────────────────────────────────────────────────

export class AcpSessionHandleImpl implements SessionHandle {
  readonly id: string;
  readonly agentName: string;
  readonly protocolIds: ProtocolIds;

  // ACP-internal fields — opaque to callers above the adapter boundary.
  readonly _client: AcpClient;
  /**
   * Mutable. Holds the live acpx session pointer. Re-assigned by `sendTurn` on
   * NO_SESSION (exit code 4) recovery so a subsequent `closeSession` targets the
   * recreated server-side session, not the dead one. The handle's identity
   * (`id`, `_sessionName`) is preserved across recovery — SessionManager's
   * descriptor sees no lifecycle event. See `sendTurn` NO_SESSION block for the
   * ADR-019 boundary rationale (transport-level reconnect, not lifecycle).
   */
  _session: AcpSession;
  readonly _sessionName: string;
  readonly _resumed: boolean;
  readonly _timeoutSeconds: number;
  readonly _modelDef: ModelDef;
  readonly _permissionMode: string;

  constructor(opts: {
    id: string;
    agentName: string;
    protocolIds: ProtocolIds;
    client: AcpClient;
    session: AcpSession;
    sessionName: string;
    resumed: boolean;
    timeoutSeconds: number;
    modelDef: ModelDef;
    permissionMode: string;
  }) {
    this.id = opts.id;
    this.agentName = opts.agentName;
    this.protocolIds = opts.protocolIds;
    this._client = opts.client;
    this._session = opts.session;
    this._sessionName = opts.sessionName;
    this._resumed = opts.resumed;
    this._timeoutSeconds = opts.timeoutSeconds;
    this._modelDef = opts.modelDef;
    this._permissionMode = opts.permissionMode;
  }
}
