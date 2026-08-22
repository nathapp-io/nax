/**
 * SpawnAcpSession — live acpx session backed by SpawnAcpClient.createSession /
 * loadSession. Split out of spawn-client.ts to stay under the file-size ratchet.
 * Each prompt() call spawns: acpx --cwd ... <agent> prompt -s <name> --file -
 */

import { randomUUID } from "node:crypto";
import {
  type AcpLineActivity,
  type AcpSession,
  type AcpSessionResponse,
  createParseState,
  finalizeParseState,
} from "@/agents";
import type { PipelineStage } from "@/config";
import { getSafeLogger } from "@/logger";
import type { AgentStreamEvent } from "@/runtime";
import { _spawnClientDeps } from "./spawn-client-deps";
import { killProcessTree, makeStreamDrain, runTrackedSpawn } from "./spawn-client-process";
import { readAndParseLines, readStreamTail } from "./stdout-line-reader";

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
  private readonly stage?: PipelineStage;
  /** Resolved teardown deadline (ms) — config.agent.acp.trackedSpawnDeadlineMs, falling back to the module default (#1583). */
  private readonly trackedSpawnDeadlineMs: number;
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
    stage?: PipelineStage;
    trackedSpawnDeadlineMs?: number;
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
    this.trackedSpawnDeadlineMs = opts.trackedSpawnDeadlineMs ?? _spawnClientDeps.trackedSpawnDeadlineMs;
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
      // MEM-1: cap stderr to a 64KB rolling tail instead of buffering the full stream.
      const stderrPromise = readStreamTail(proc.stderr).catch(() => "");

      const exitCode = await proc.exited;

      // Bun bug: piped streams may not close after kill (e.g. cancelActivePrompt SIGTERM).
      // Race each stream against its own cancellable drain timer so prompt() always resolves
      // instead of hanging. Timers are cancelled as soon as the stream resolves to avoid
      // keeping uncancellable timers alive across multi-turn sessions. (Shared helper —
      // MEM-19 uses the same one for runTrackedSpawn's normal-exit drain.)
      const drainA = makeStreamDrain(_spawnClientDeps.streamDrainTimeoutMs);
      const drainB = makeStreamDrain(_spawnClientDeps.streamDrainTimeoutMs);
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
    // Issue #1583: teardown ops (close/cancel) use the resolved teardown
    // deadline, never the startup deadline — see trackedSpawnDeadlineMs field.
    return runTrackedSpawn(
      { ..._spawnClientDeps, trackedSpawnDeadlineMs: this.trackedSpawnDeadlineMs },
      cmd,
      opts,
      this.onPidSpawned,
      this.onPidExited,
      signal,
    );
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
        // BUG-3: --cwd required — without it acpx resolves against nax's
        // process cwd instead of this session's worktree, risking a hit
        // against (or a miss of) the wrong queue owner in a parallel run
        // where multiple instances of the same agentName run concurrently.
        await this.trackedSpawn(["acpx", "--cwd", this.cwd, this.agentName, "stop"], undefined, options?.signal);
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

    // BUG-3: --cwd required — see the matching comment on close()'s "stop" call.
    const cmd = ["acpx", "--cwd", this.cwd, this.agentName, "cancel"];
    getSafeLogger()?.debug("acp-adapter", `Cancelling active prompt: ${this.sessionName}`);

    await this.trackedSpawn(cmd);
  }
}
