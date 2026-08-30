/**
 * Spawn-based ACP Client — default production implementation.
 *
 * Implements AcpClient by shelling out to acpx CLI (`sessions ensure` /
 * `sessions close`). This is the real transport; createClient injectable
 * defaults to this. Tests override createClient with mock implementations.
 * The AcpSession side (`prompt` / `close` / `cancelActivePrompt`, i.e. `acpx
 * ... prompt -s <name>` / `sessions close <name>` / `cancel`) is implemented
 * by SpawnAcpSession in ./spawn-client-session.
 */

import type { AcpClient, AcpClientOptions, AcpSession } from "@/agents";
import { getSafeLogger } from "@/logger";
import type { AgentStreamEvent } from "@/runtime";
import { buildAllowedEnv } from "../shared/env";
import { parseModelSpec } from "./model-spec";
import { applyReasoningEffort } from "./reasoning-effort";
import { parseSessionIds } from "./session-ids";
import { _spawnClientDeps } from "./spawn-client-deps";
import { runTrackedSpawn } from "./spawn-client-process";
import { SpawnAcpSession } from "./spawn-client-session";

export { _spawnClientDeps } from "./spawn-client-deps";
export { SpawnAcpSession } from "./spawn-client-session";

export const DEFAULT_ACP_TIMEOUT_SECONDS = 1800;

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
  readonly timeoutSeconds: number;
  private readonly promptRetries: number;
  private readonly env: Record<string, string | undefined>;
  private readonly onPidSpawned?: (pid: number) => void;
  private readonly onPidExited?: (pid: number) => void;
  private readonly onStreamActivity?: (event: AgentStreamEvent) => void;
  private readonly onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  private readonly runId?: string;
  private readonly storyId?: string;
  private readonly stage?: import("@/config").PipelineStage;
  /** Resolved teardown deadline (ms), forwarded to sessions this client creates (#1583). */
  private readonly trackedSpawnDeadlineMs: number;
  /** Resolved startup deadline (ms) — used by this client's own trackedSpawn (createSession/loadSession/applyReasoningEffort) (#1583). */
  private readonly trackedSpawnStartupDeadlineMs: number;

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
    this.timeoutSeconds = timeoutSeconds ?? DEFAULT_ACP_TIMEOUT_SECONDS;
    this.promptRetries = promptRetries ?? 0;
    // BUG-15: modelDef.env (config.models.<agent>.<tier>.env) was accepted by
    // the schema but never threaded here — a per-model API key/base URL
    // override was silently ignored, and the subprocess ran on ambient env
    // only, surfacing as confusing auth errors instead of the configured key.
    this.env = buildAllowedEnv({ modelEnv: opts?.env });
    this.onPidSpawned = onPidSpawned;
    this.onPidExited = onPidExited;
    this.onStreamActivity = opts?.onStreamActivity;
    this.onActiveCall = opts?.onActiveCall;
    this.runId = opts?.runId;
    this.storyId = opts?.storyId;
    this.stage = opts?.stage;
    this.trackedSpawnDeadlineMs = opts?.trackedSpawnDeadlineMs ?? _spawnClientDeps.trackedSpawnDeadlineMs;
    this.trackedSpawnStartupDeadlineMs =
      opts?.trackedSpawnStartupDeadlineMs ?? _spawnClientDeps.trackedSpawnStartupDeadlineMs;
  }

  async start(): Promise<void> {
    // No-op — spawn-based client doesn't need upfront initialization
  }

  /**
   * Spawn an acpx command. Issue #1583: most callers of this client's
   * trackedSpawn — createSession/loadSession/applyReasoningEffort — are
   * startup ops (`sessions ensure`), so it defaults to the startup deadline,
   * NOT SpawnAcpSession's teardown deadline. `sessions ensure` measured a
   * real-world median of 8.15s. `closeSession` (a teardown op that goes
   * through this client rather than a live SpawnAcpSession) passes the
   * teardown deadline explicitly via `deadlineMsOverride`.
   */
  private async trackedSpawn(
    cmd: string[],
    signal?: AbortSignal,
    deadlineMsOverride?: number,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return runTrackedSpawn(
      { ..._spawnClientDeps, trackedSpawnDeadlineMs: deadlineMsOverride ?? this.trackedSpawnStartupDeadlineMs },
      cmd,
      undefined,
      this.onPidSpawned,
      this.onPidExited,
      signal,
    );
  }

  async createSession(opts: { agentName: string; permissionMode: string; sessionName?: string }): Promise<AcpSession> {
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
      trackedSpawnDeadlineMs: this.trackedSpawnDeadlineMs,
    });
  }

  async loadSession(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null> {
    // `sessions ensure` resumes an OPEN named session, or creates a new one if none is
    // open (a closed session is not resumable — it yields a fresh, context-less session).
    // --format json surfaces the session UUID in stdout.
    const cmd = ["acpx", "--cwd", this.cwd, "--format", "json", agentName, "sessions", "ensure", "--name", sessionName];

    const { exitCode, stdout } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      // Issue #1583: exitCode -1 means runTrackedSpawn hit its deadline (or an
      // external abort) and killed the process — a DIFFERENT situation from a
      // genuine "no session exists" miss (non-zero exit from acpx itself). Both
      // fall back to a context-less createSession below, but the timeout case
      // silently degraded reviewer/session context with no visible signal.
      // Surface it so it's distinguishable from a normal miss.
      if (exitCode === -1) {
        getSafeLogger()?.warn(
          "acp-adapter",
          "sessions ensure hit its trackedSpawn deadline — falling back to a context-less session",
          { sessionName, agentName },
        );
      }
      return null; // Session doesn't exist, can't be resumed, or the ensure call timed out
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
      trackedSpawnDeadlineMs: this.trackedSpawnDeadlineMs,
    });
  }

  async closeSession(sessionName: string, agentName: string, signal?: AbortSignal): Promise<void> {
    const cmd = ["acpx", "--cwd", this.cwd, agentName, "sessions", "close", sessionName];
    // Teardown op — use the teardown deadline, not the (longer) startup default.
    const { exitCode, stderr } = await this.trackedSpawn(cmd, signal, this.trackedSpawnDeadlineMs);
    if (exitCode !== 0) {
      getSafeLogger()?.debug("acp-adapter", "Session close failed (ignored)", {
        sessionName,
        agentName,
        exitCode,
        stderr: stderr.slice(0, 200),
      });
    }
  }

  /**
   * BUG-16: hard-terminate the acpx queue-owner process for `agentName` via
   * `acpx --cwd <cwd> <agentName> stop`. `--cwd` is required here — acpx
   * scopes session/queue-owner lookups to the invoking cwd (mirrors
   * `sessions close`'s "current cwd" semantics), and without it this would
   * default to the spawned acpx process's own cwd rather than this client's
   * worktree, risking a hit against — or a miss of — the wrong queue owner
   * in a parallel/worktree run where multiple agent instances of the same
   * `agentName` run concurrently in different directories.
   * Mirrors the session-level hard-stop already used by
   * SpawnAcpSession.close({ forceTerminate: true }) (spawn-client-session.ts).
   * Failures are logged and swallowed — the caller (closePhysicalSession)
   * already wraps this in a best-effort `.catch(() => {})`, but logging here
   * gives visibility into why a force-close didn't actually terminate.
   */
  async forceStop(agentName: string, signal?: AbortSignal): Promise<void> {
    const cmd = ["acpx", "--cwd", this.cwd, agentName, "stop"];
    const { exitCode, stderr } = await this.trackedSpawn(cmd, signal, this.trackedSpawnDeadlineMs);
    if (exitCode !== 0) {
      getSafeLogger()?.debug("acp-adapter", "forceStop failed (ignored)", {
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
