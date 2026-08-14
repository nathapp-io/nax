/**
 * Spawn-based ACP Client — default production implementation.
 *
 * Implements AcpClient/AcpSession interfaces by shelling out to acpx CLI.
 * This is the real transport; createClient injectable defaults to this.
 * Tests override createClient with mock implementations.
 *
 * CLI commands used:
 *   acpx <agent> sessions ensure --name <name>      → ensureSession
 *   acpx --cwd <dir> ... <agent> prompt -s <name>   → session.prompt()
 *   acpx <agent> sessions close <name>              → session.close()
 *   acpx <agent> cancel                             → session.cancelActivePrompt()
 */

import { randomUUID } from "node:crypto";
import {
  type AcpClient,
  type AcpClientOptions,
  type AcpLineActivity,
  type AcpSession,
  type AcpSessionResponse,
  createParseState,
  finalizeParseState,
} from "@/agents";
import { getSafeLogger } from "@/logger";
import type { AgentStreamEvent } from "@/runtime";
import { typedSpawn } from "@/utils/bun-deps";
import { buildAllowedEnv } from "../shared/env";
import { parseModelSpec } from "./model-spec";
import { applyReasoningEffort } from "./reasoning-effort";
import { parseSessionIds } from "./session-ids";
import { killProcessTree, runTrackedSpawn } from "./spawn-client-process";
import { readAndParseLines } from "./stdout-line-reader";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Grace period for stream drain after acpx exits — handles Bun bug where
// piped streams may not close after SIGTERM (e.g. cancelActivePrompt).
const ACPX_STREAM_DRAIN_TIMEOUT_MS = 5_000;

// ORPHAN-1: SIGTERM->SIGKILL escalation grace period for killProcessTree() (see
// spawn-client-process.ts). Shorter than executor.ts's since close()/
// cancelActivePrompt() are already tearing the session down.
const KILL_TREE_GRACE_MS = 250;

// PERF-1: hard deadline on trackedSpawn's proc.exited await (see
// spawn-client-process.ts) — bounds the normal-exit teardown path the same way
// the crash-signal path's outer 10s hard deadline bounds crash-signals.ts.
const TRACKED_SPAWN_DEADLINE_MS = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Spawn helper (injectable for future testing if needed)
// ─────────────────────────────────────────────────────────────────────────────

export const _spawnClientDeps = {
  spawn: typedSpawn,
  /** Stream drain timeout after proc.exited — injectable so tests can use a short value. */
  streamDrainTimeoutMs: ACPX_STREAM_DRAIN_TIMEOUT_MS,
  /** SIGTERM->SIGKILL escalation grace period — injectable so tests can use a short value. */
  killTreeGraceMs: KILL_TREE_GRACE_MS,
  /** trackedSpawn hard deadline — injectable so tests can use a short value. */
  trackedSpawnDeadlineMs: TRACKED_SPAWN_DEADLINE_MS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Line-reader helper
// ─────────────────────────────────────────────────────────────────────────────

// readAndParseLines lives in ./stdout-line-reader (split out to stay under the file-size limit).

// ─────────────────────────────────────────────────────────────────────────────
// Env builder
// ─────────────────────────────────────────────────────────────────────────────

// buildAllowedEnv imported from ../shared/env — single canonical implementation

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpSession
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An ACP session backed by acpx CLI spawn.
 * Each prompt() call spawns: acpx --cwd ... <agent> prompt -s <name> --file -
 */
export class SpawnAcpSession implements AcpSession {
  private readonly agentName: string;
  private readonly sessionName: string;
  private readonly cwd: string;
  private readonly model: string;
  /** Original profile model string, including any [effort] suffix. Display only. */
  private readonly modelLabel: string;
  private readonly timeoutSeconds: number;
  private readonly promptRetries: number;
  private readonly permissionMode: string;
  private readonly env: Record<string, string | undefined>;
  private readonly onPidSpawned?: (pid: number) => void;
  private readonly onPidExited?: (pid: number) => void;
  private readonly onStreamActivity?: (event: AgentStreamEvent) => void;
  private readonly onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  private readonly runId: string;
  private readonly storyId?: string;
  private readonly stage?: import("../../config/permissions").PipelineStage;
  private activeProc: { pid: number; kill(signal?: number): void; exited?: Promise<number> } | null = null;
  /**
   * Transport fact: `cancelActivePrompt()` was invoked during the in-flight
   * prompt(). The resulting AcpSessionResponse is stamped with `cancelled: true`
   * so the wiring layer (above the adapter) can classify the failure.
   * Cleared at the start of each prompt() invocation.
   */
  private _externallyCancelled = false;
  /** Volatile Claude Code session ID (acpxSessionId) — updated on reconnect. */
  readonly id?: string;
  /** Stable record ID (acpxRecordId) — assigned at creation, never changes. */
  readonly recordId?: string;

  constructor(opts: {
    agentName: string;
    sessionName: string;
    cwd: string;
    model: string;
    modelLabel?: string;
    timeoutSeconds: number;
    promptRetries: number;
    permissionMode: string;
    env: Record<string, string | undefined>;
    onPidSpawned?: (pid: number) => void;
    onPidExited?: (pid: number) => void;
    id?: string;
    recordId?: string;
    onStreamActivity?: (event: AgentStreamEvent) => void;
    onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
    runId?: string;
    storyId?: string;
    stage?: import("../../config/permissions").PipelineStage;
  }) {
    this.agentName = opts.agentName;
    this.sessionName = opts.sessionName;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.modelLabel = opts.modelLabel ?? opts.model;
    this.timeoutSeconds = opts.timeoutSeconds;
    this.promptRetries = opts.promptRetries;
    this.permissionMode = opts.permissionMode;
    this.env = opts.env;
    this.onPidSpawned = opts.onPidSpawned;
    this.onPidExited = opts.onPidExited;
    this.onStreamActivity = opts.onStreamActivity;
    this.onActiveCall = opts.onActiveCall;
    this.runId = opts.runId ?? "";
    this.storyId = opts.storyId;
    this.stage = opts.stage;
    this.id = opts.id;
    this.recordId = opts.recordId;
  }

  async prompt(text: string): Promise<AcpSessionResponse> {
    const callId = randomUUID();
    const emit = this.onStreamActivity;
    const now = () => Date.now();
    // Each prompt() starts with a fresh cancellation state — a stale flag from
    // a prior cancelled prompt must not leak into the next call.
    this._externallyCancelled = false;
    const baseEvent = {
      callId,
      runId: this.runId,
      agentName: this.agentName,
      sessionName: this.sessionName,
      storyId: this.storyId,
      stage: this.stage,
    } as const;

    const cmd = [
      "acpx",
      "--cwd",
      this.cwd,
      "--format",
      "json",
      ...(this.permissionMode === "approve-all" ? ["--approve-all"] : []),
      "--model",
      this.model,
      "--timeout",
      String(this.timeoutSeconds),
      ...(this.promptRetries > 0 ? ["--prompt-retries", String(this.promptRetries)] : []),
      this.agentName,
      "prompt",
      "-s",
      this.sessionName,
      "--file",
      "-",
    ];

    getSafeLogger()?.info("acp-adapter", "Sending prompt", {
      session: this.sessionName,
      permission: this.permissionMode,
      cmd: cmd.join(" "),
    });
    getSafeLogger()?.debug("acp-adapter", `Sending prompt to session: ${this.sessionName}`);

    let proc: ReturnType<typeof _spawnClientDeps.spawn>;
    try {
      proc = _spawnClientDeps.spawn(cmd, {
        cwd: this.cwd,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: this.env,
        // ORPHAN-1: real process-group leader — close()/cancelActivePrompt() can
        // killProcessTree() the whole group instead of leaking descendants.
        detached: true,
      });
    } catch (spawnErr) {
      // Spawn threw before a PID was obtained — AC9: emit call_ended without a prior call_started
      emit?.({ ...baseEvent, kind: "agent.call_ended", status: "error", timestamp: now() });
      throw spawnErr;
    }

    this.activeProc = proc;
    const processPid = proc.pid;
    this.onPidSpawned?.(processPid);

    // Register the watchdog cancel function only after spawn succeeds and we have a live PID.
    // Registering before spawn would leave a stale registry entry if spawn throws (#2).
    this.onActiveCall?.(callId, () => this.cancelActivePrompt());

    // AC5/AC6: Emit call_started after spawn succeeds (PID obtained), before process_update
    emit?.({
      ...baseEvent,
      kind: "agent.call_started",
      model: this.modelLabel,
      timeoutSeconds: this.timeoutSeconds,
      timestamp: now(),
    });

    // AC6: Emit process_update(spawned) AFTER PID registration
    emit?.({
      ...baseEvent,
      kind: "agent.process_update",
      status: "spawned",
      pid: processPid,
      timestamp: now(),
    });

    let exitNotified = false;
    const notifyExit = (): void => {
      if (exitNotified) return;
      exitNotified = true;
      try {
        this.onPidExited?.(processPid);
      } catch {
        // unregister is best-effort — never let it surface from prompt()
      }
    };

    // AC8: Guard to ensure call_ended is emitted exactly once across all terminal paths
    let callEndedEmitted = false;

    try {
      try {
        proc.stdin?.write(text);
        proc.stdin?.end();
      } catch {
        // acpx exited before nax could write the prompt (EPIPE / broken pipe).
        // This is expected when the subprocess crashes on startup.
        // Do not rethrow — let proc.exited report the real exit code and stderr.
        getSafeLogger()?.warn("acp-adapter", "Failed to write prompt to acpx stdin (subprocess exited early)", {
          session: this.sessionName,
        });
      }

      // Line-reader: parse stdout incrementally as lines arrive instead of buffering
      // the full NDJSON output. Only extracted fields (strings + numbers) are held in
      // memory — raw bytes are discarded immediately after each line is processed.
      // .catch(() => {}) guards against stream errors (e.g. acpx crash mid-run).
      // AC7: Emit activity events during stdout reading.
      const parseState = createParseState();
      const onActivity = emit
        ? (activity: AcpLineActivity) => {
            if (activity.kind === "message_update") {
              emit({ ...baseEvent, kind: "agent.message_update", deltaBytes: activity.deltaBytes, timestamp: now() });
            } else if (activity.kind === "thinking_update") {
              emit({ ...baseEvent, kind: "agent.thinking_update", deltaBytes: activity.deltaBytes, timestamp: now() });
            } else if (activity.kind === "usage_update") {
              emit({
                ...baseEvent,
                kind: "agent.usage_update",
                inputTokens: activity.inputTokens,
                outputTokens: activity.outputTokens,
                costUsd: activity.costUsd,
                timestamp: now(),
              });
            } else if (activity.kind === "tool_call_update") {
              emit({
                ...baseEvent,
                kind: "agent.tool_call_update",
                toolName: activity.toolName,
                timestamp: now(),
              });
            }
          }
        : undefined;
      const parseHandle = readAndParseLines(proc.stdout, parseState, onActivity);
      const parsePromise = parseHandle.promise.catch(() => {});
      const stderrPromise = new Response(proc.stderr).text().catch(() => "");

      const exitCode = await proc.exited;

      // Bun bug: piped streams may not close after kill (e.g. cancelActivePrompt SIGTERM).
      // Race each stream against its own cancellable drain timer so prompt() always resolves
      // instead of hanging. Timers are cancelled as soon as the stream resolves to avoid
      // keeping uncancellable timers alive across multi-turn sessions.
      const makeDrain = (ms: number): { promise: Promise<string>; cancel: () => void } => {
        let id: ReturnType<typeof setTimeout> | undefined;
        const promise = new Promise<string>((resolve) => {
          id = setTimeout(() => resolve(""), ms);
        });
        // Promise executor runs synchronously — id is set before return.
        return { promise, cancel: () => clearTimeout(id) };
      };
      const drainA = makeDrain(_spawnClientDeps.streamDrainTimeoutMs);
      const drainB = makeDrain(_spawnClientDeps.streamDrainTimeoutMs);
      const stdoutRaceResult = Promise.race([
        parsePromise.then(() => "parsed" as const),
        drainA.promise.then(() => "drain" as const),
      ]).finally(() => drainA.cancel());
      const [stdoutWinner, stderr] = await Promise.all([
        stdoutRaceResult,
        Promise.race([stderrPromise, drainB.promise]).finally(() => drainB.cancel()),
      ]);
      // Drain timeout won the race: cancel the stdout reader so its pending read()
      // settles and the reader/lock isn't held for the rest of the process (BUG-46).
      if (stdoutWinner === "drain") parseHandle.cancel();

      // Emit process_update(exited) after exit code is known
      emit?.({ ...baseEvent, kind: "agent.process_update", status: "exited", exitCode, timestamp: now() });

      if (exitCode !== 0) {
        // Prefer parsed stdout error (JSON-RPC error response from acpx) over raw stderr.
        // stderr at this point is typically the acpx session banner ("agent needs reconnect")
        // which describes connection state, not the actual failure reason.
        const parsedOnError = finalizeParseState(parseState);
        // Prefer the parsed JSON-RPC error from stdout over raw stderr.
        // Do NOT fall back to parsedOnError.text — it may be partial streaming content
        // accumulated before the crash and would mislead error classification callers.
        const errorContent = parsedOnError.error || stderr || `Exit code ${exitCode}`;
        getSafeLogger()?.warn("acp-adapter", `Session prompt exited with code ${exitCode}`, {
          exitCode,
          error: errorContent.slice(0, 500),
          ...(stderr && stderr !== errorContent ? { banner: stderr.trim().slice(0, 200) } : {}),
        });
        // AC8: Emit call_ended on non-zero exit path
        callEndedEmitted = true;
        emit?.({ ...baseEvent, kind: "agent.call_ended", status: "error", exitCode, timestamp: now() });
        const errResponse: AcpSessionResponse = {
          messages: [{ role: "assistant", content: errorContent }],
          stopReason: "error",
          retryable: parsedOnError.retryable,
          exitCode,
        };
        if (this._externallyCancelled) errResponse.cancelled = true;
        return errResponse;
      }

      try {
        const parsed = finalizeParseState(parseState);
        // AC8/BUG-2: an exit-0 turn that was externally cancelled (agent exited
        // cleanly on cancelActivePrompt()'s SIGTERM) is not a clean success.
        callEndedEmitted = true;
        const cancelled = this._externallyCancelled;
        emit?.({ ...baseEvent, kind: "agent.call_ended", status: cancelled ? "error" : "success", timestamp: now() });
        // BUG-1: carry parsed.error/retryable through even on the success path —
        // finalizeParseState can capture a JSON-RPC error envelope on an exit-0 turn.
        const successResponse: AcpSessionResponse = {
          messages: [{ role: "assistant", content: parsed.text || "" }],
          stopReason: cancelled ? "error" : (parsed.stopReason ?? "end_turn"),
          cumulative_token_usage: parsed.tokenUsage,
          exactCostUsd: parsed.exactCostUsd,
          error: parsed.error,
          retryable: parsed.retryable,
        };
        if (cancelled) successResponse.cancelled = true;
        return successResponse;
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", "Failed to parse session prompt response", {
          stderr: stderr.slice(0, 200),
        });
        throw err;
      }
    } catch (err) {
      // AC8: Emit call_ended exactly once for all thrown paths (stream errors, parse failure, etc.)
      if (!callEndedEmitted) {
        callEndedEmitted = true;
        emit?.({ ...baseEvent, kind: "agent.call_ended", status: "error", timestamp: now() });
      }
      throw err;
    } finally {
      this.activeProc = null;
      notifyExit();
    }
  }

  /**
   * Spawn an acpx command. Drains stdout/stderr concurrently to avoid pipe-buffer
   * deadlock. PERF-1: bounded by a hard deadline — see runTrackedSpawn's doc comment.
   */
  private async trackedSpawn(
    cmd: string[],
    opts?: Parameters<typeof _spawnClientDeps.spawn>[1],
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runTrackedSpawn(_spawnClientDeps, cmd, opts, this.onPidSpawned, this.onPidExited, signal);
  }

  /** ORPHAN-1: terminate the in-flight prompt's process tree — see killProcessTree's doc comment. */
  private killActiveProcTree(): void {
    if (!this.activeProc) return;
    // BUG-6: pass `exited` so killProcessTree skips SIGKILL if already exited.
    killProcessTree(this.activeProc.pid, _spawnClientDeps.killTreeGraceMs, this.activeProc.exited);
  }

  async close(options?: { forceTerminate?: boolean; signal?: AbortSignal }): Promise<void> {
    // Kill in-flight prompt process tree first (if any)
    if (this.activeProc) {
      this.killActiveProcTree();
      this.activeProc = null;
    }

    const cmd = ["acpx", "--cwd", this.cwd, this.agentName, "sessions", "close", this.sessionName];
    getSafeLogger()?.debug("acp-adapter", `Closing session: ${this.sessionName}`);

    const { exitCode, stderr } = await this.trackedSpawn(cmd, undefined, options?.signal);

    if (exitCode !== 0) {
      getSafeLogger()?.warn("acp-adapter", "Failed to close session", {
        sessionName: this.sessionName,
        stderr: stderr.slice(0, 200),
      });
    }

    if (options?.forceTerminate) {
      try {
        await this.trackedSpawn(["acpx", this.agentName, "stop"], undefined, options?.signal);
      } catch (err) {
        getSafeLogger()?.debug("acp-adapter", "acpx stop failed (swallowed)", { cause: String(err) });
      }
    }
  }

  async cancelActivePrompt(): Promise<void> {
    // Mark the in-flight prompt as externally cancelled so the resulting
    // AcpSessionResponse is stamped with `cancelled: true`. The wiring layer
    // above the adapter classifies _why_ (e.g. fail-stale when the watchdog
    // triggered the cancel).
    this._externallyCancelled = true;

    // Kill in-flight prompt process tree directly (faster than acpx cancel)
    if (this.activeProc) {
      this.killActiveProcTree();
      this.activeProc = null; // LOW: null out after kill, matching close()
    }

    const cmd = ["acpx", this.agentName, "cancel"];
    getSafeLogger()?.debug("acp-adapter", `Cancelling active prompt: ${this.sessionName}`);

    await this.trackedSpawn(cmd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SpawnAcpClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ACP client backed by acpx CLI.
 *
 * The cmdStr is parsed to extract --model and agent name:
 *   "acpx --model claude-sonnet-4-5 claude" → model=claude-sonnet-4-5, agent=claude
 *
 * createSession() and loadSession() both run: acpx <agent> sessions ensure --name <name>
 * `sessions ensure` resumes the named session ONLY while it is still open; if no open
 * session with that name exists (e.g. it was previously `sessions close`d), acpx creates
 * a fresh one. A session closed via closeSession() is therefore NOT resumable — the next
 * loadSession() returns a brand-new, context-less session. Ops whose conversation context
 * must survive across turns keep their session open via shouldKeepSessionOpen (the
 * keepOpen resolver), which skips closeSession.
 */
export class SpawnAcpClient implements AcpClient {
  private readonly model: string;
  /** Original --model string, including any [effort] suffix. Display only. */
  private readonly rawModel: string;
  /** Reasoning effort split off the profile's model suffix, applied once per session. */
  private readonly reasoningEffort?: string;
  readonly cwd: string;
  private readonly timeoutSeconds: number;
  private readonly promptRetries: number;
  private readonly env: Record<string, string | undefined>;
  private readonly onPidSpawned?: (pid: number) => void;
  private readonly onPidExited?: (pid: number) => void;
  private readonly onStreamActivity?: (event: AgentStreamEvent) => void;
  private readonly onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  private readonly runId?: string;
  private readonly storyId?: string;
  private readonly stage?: import("../../config/permissions").PipelineStage;

  constructor(
    cmdStr: string,
    cwd?: string,
    timeoutSeconds?: number,
    onPidSpawned?: (pid: number) => void,
    promptRetries?: number,
    onPidExited?: (pid: number) => void,
    opts?: AcpClientOptions,
  ) {
    // Parse: "acpx --model <model> <agentName>"
    const parts = cmdStr.split(/\s+/);
    const modelIdx = parts.indexOf("--model");
    const rawModel = modelIdx >= 0 && parts[modelIdx + 1] ? parts[modelIdx + 1] : "default";
    const spec = parseModelSpec(rawModel);
    this.rawModel = rawModel;
    this.model = spec.model;
    this.reasoningEffort = spec.effort;
    // Agent name is the last non-flag token — must be present and not a flag
    const lastToken = parts[parts.length - 1];
    if (!lastToken || lastToken.startsWith("-")) {
      throw new Error(`[acp-adapter] Could not parse agentName from cmdStr: "${cmdStr}"`);
    }
    if (!cwd) {
      throw new Error("[acp-adapter] SpawnAcpClient requires cwd");
    }
    this.cwd = cwd;
    this.timeoutSeconds = timeoutSeconds || 1800;
    this.promptRetries = promptRetries ?? 0;
    this.env = buildAllowedEnv();
    this.onPidSpawned = onPidSpawned;
    this.onPidExited = onPidExited;
    this.onStreamActivity = opts?.onStreamActivity;
    this.onActiveCall = opts?.onActiveCall;
    this.runId = opts?.runId;
    this.storyId = opts?.storyId;
    this.stage = opts?.stage;
  }

  async start(): Promise<void> {
    // No-op — spawn-based client doesn't need upfront initialization
  }

  /** Spawn an acpx command. PERF-1: bounded by the same deadline as SpawnAcpSession.trackedSpawn. */
  private async trackedSpawn(
    cmd: string[],
    signal?: AbortSignal,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runTrackedSpawn(_spawnClientDeps, cmd, undefined, this.onPidSpawned, this.onPidExited, signal);
  }

  async createSession(opts: {
    agentName: string;
    permissionMode: string;
    sessionName?: string;
  }): Promise<AcpSession> {
    const sessionName = opts.sessionName || `nax-${Date.now()}`;

    // Ensure session exists via CLI — --format json surfaces the session UUID in stdout
    const cmd = [
      "acpx",
      "--cwd",
      this.cwd,
      "--format",
      "json",
      opts.agentName,
      "sessions",
      "ensure",
      "--name",
      sessionName,
    ];
    getSafeLogger()?.debug("acp-adapter", `Ensuring session: ${sessionName}`);

    const { exitCode, stdout, stderr } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      // Use stdout first — acpx puts the JSON-RPC error there when --format json is set.
      throw new Error(`[acp-adapter] Failed to create session: ${stdout || stderr || `exit code ${exitCode}`}`);
    }

    const { sessionId, recordId } = parseSessionIds(stdout);
    await applyReasoningEffort({
      effort: this.reasoningEffort,
      agentName: opts.agentName,
      sessionName,
      cwd: this.cwd,
      storyId: this.storyId,
      spawn: (c) => this.trackedSpawn(c),
    });
    return new SpawnAcpSession({
      agentName: opts.agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      modelLabel: this.rawModel,
      timeoutSeconds: this.timeoutSeconds,
      promptRetries: this.promptRetries,
      permissionMode: opts.permissionMode,
      env: this.env,
      onPidSpawned: this.onPidSpawned,
      onPidExited: this.onPidExited,
      onStreamActivity: this.onStreamActivity,
      onActiveCall: this.onActiveCall,
      runId: this.runId,
      storyId: this.storyId,
      stage: this.stage,
      id: sessionId,
      recordId,
    });
  }

  async loadSession(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null> {
    // `sessions ensure` resumes an OPEN named session, or creates a new one if none is
    // open (a closed session is not resumable — it yields a fresh, context-less session).
    // --format json surfaces the session UUID in stdout.
    const cmd = ["acpx", "--cwd", this.cwd, "--format", "json", agentName, "sessions", "ensure", "--name", sessionName];

    const { exitCode, stdout } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      return null; // Session doesn't exist or can't be resumed
    }

    const { sessionId, recordId } = parseSessionIds(stdout);
    await applyReasoningEffort({
      effort: this.reasoningEffort,
      agentName,
      sessionName,
      cwd: this.cwd,
      storyId: this.storyId,
      spawn: (c) => this.trackedSpawn(c),
    });
    return new SpawnAcpSession({
      agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      modelLabel: this.rawModel,
      timeoutSeconds: this.timeoutSeconds,
      promptRetries: this.promptRetries,
      permissionMode,
      env: this.env,
      onPidSpawned: this.onPidSpawned,
      onPidExited: this.onPidExited,
      onStreamActivity: this.onStreamActivity,
      onActiveCall: this.onActiveCall,
      runId: this.runId,
      storyId: this.storyId,
      stage: this.stage,
      id: sessionId,
      recordId,
    });
  }

  async closeSession(sessionName: string, agentName: string, signal?: AbortSignal): Promise<void> {
    const cmd = ["acpx", "--cwd", this.cwd, agentName, "sessions", "close", sessionName];
    const { exitCode, stderr } = await this.trackedSpawn(cmd, signal);
    if (exitCode !== 0) {
      getSafeLogger()?.debug("acp-adapter", "Session close failed (ignored)", {
        sessionName,
        agentName,
        exitCode,
        stderr: stderr.slice(0, 200),
      });
    }
  }

  async close(): Promise<void> {
    // No-op — spawn-based client has no persistent connection
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a spawn-based ACP client. This is the default production factory.
 * The cmdStr format is: "acpx --model <model> <agentName>"
 */
export function createSpawnAcpClient(
  cmdStr: string,
  cwd: string,
  timeoutSeconds?: number,
  onPidSpawned?: (pid: number) => void,
  promptRetries?: number,
  onPidExited?: (pid: number) => void,
  opts?: AcpClientOptions,
): AcpClient {
  return new SpawnAcpClient(cmdStr, cwd, timeoutSeconds, onPidSpawned, promptRetries, onPidExited, opts);
}
