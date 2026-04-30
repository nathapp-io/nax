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

import { getSafeLogger } from "../../logger";
import { typedSpawn } from "../../utils/bun-deps";
import { buildAllowedEnv } from "../shared/env";
import type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter-session-types";
import { type AcpxParseState, createParseState, finalizeParseState, parseAcpxJsonLine } from "./parser";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Grace period for stream drain after acpx exits — handles Bun bug where
// piped streams may not close after SIGTERM (e.g. cancelActivePrompt).
const ACPX_STREAM_DRAIN_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Spawn helper (injectable for future testing if needed)
// ─────────────────────────────────────────────────────────────────────────────

export const _spawnClientDeps = {
  spawn: typedSpawn,
  /** Stream drain timeout after proc.exited — injectable so tests can use a short value. */
  streamDrainTimeoutMs: ACPX_STREAM_DRAIN_TIMEOUT_MS,
};

// ─────────────────────────────────────────────────────────────────────────────
// Line-reader helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read chunks from a stream, split on newlines, and feed each complete line
 * into an AcpxParseState incrementally. Discards raw bytes immediately after
 * parsing so only the extracted fields (strings + numbers) are held in memory.
 *
 * The caller races this promise against a drain timeout to handle the Bun bug
 * where piped streams may not close after SIGTERM.
 */
async function readAndParseLines(stream: ReadableStream<Uint8Array>, state: AcpxParseState): Promise<void> {
  const decoder = new TextDecoder();
  let remainder = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      remainder += decoder.decode(value, { stream: true });
      for (;;) {
        const nl = remainder.indexOf("\n");
        if (nl < 0) break;
        const line = remainder.slice(0, nl);
        remainder = remainder.slice(nl + 1);
        if (line.trim()) parseAcpxJsonLine(line, state);
      }
    }
    // Flush decoder and process any content after the last newline
    remainder += decoder.decode();
    if (remainder.trim()) parseAcpxJsonLine(remainder.trim(), state);
  } finally {
    reader.releaseLock();
  }
}

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
  private readonly timeoutSeconds: number;
  private readonly promptRetries: number;
  private readonly permissionMode: string;
  private readonly env: Record<string, string | undefined>;
  private readonly onPidSpawned?: (pid: number) => void;
  private readonly onPidExited?: (pid: number) => void;
  private activeProc: { pid: number; kill(signal?: number): void } | null = null;
  /** Volatile Claude Code session ID (acpxSessionId) — updated on reconnect. */
  readonly id?: string;
  /** Stable record ID (acpxRecordId) — assigned at creation, never changes. */
  readonly recordId?: string;

  constructor(opts: {
    agentName: string;
    sessionName: string;
    cwd: string;
    model: string;
    timeoutSeconds: number;
    promptRetries: number;
    permissionMode: string;
    env: Record<string, string | undefined>;
    onPidSpawned?: (pid: number) => void;
    onPidExited?: (pid: number) => void;
    id?: string;
    recordId?: string;
  }) {
    this.agentName = opts.agentName;
    this.sessionName = opts.sessionName;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.timeoutSeconds = opts.timeoutSeconds;
    this.promptRetries = opts.promptRetries;
    this.permissionMode = opts.permissionMode;
    this.env = opts.env;
    this.onPidSpawned = opts.onPidSpawned;
    this.onPidExited = opts.onPidExited;
    this.id = opts.id;
    this.recordId = opts.recordId;
  }

  async prompt(text: string): Promise<AcpSessionResponse> {
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

    const proc = _spawnClientDeps.spawn(cmd, {
      cwd: this.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.env,
    });

    this.activeProc = proc;
    const processPid = proc.pid;
    this.onPidSpawned?.(processPid);
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
      const parseState = createParseState();
      const parsePromise = readAndParseLines(proc.stdout, parseState).catch(() => {});
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
      const [, stderr] = await Promise.all([
        Promise.race([parsePromise, drainA.promise]).finally(() => drainA.cancel()),
        Promise.race([stderrPromise, drainB.promise]).finally(() => drainB.cancel()),
      ]);

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
        // Return error response so the adapter can handle it
        return {
          messages: [{ role: "assistant", content: errorContent }],
          stopReason: "error",
          retryable: parsedOnError.retryable,
          exitCode,
        };
      }

      try {
        const parsed = finalizeParseState(parseState);
        return {
          messages: [{ role: "assistant", content: parsed.text || "" }],
          stopReason: parsed.stopReason ?? "end_turn",
          cumulative_token_usage: parsed.tokenUsage,
          exactCostUsd: parsed.exactCostUsd,
        };
      } catch (err) {
        getSafeLogger()?.warn("acp-adapter", "Failed to parse session prompt response", {
          stderr: stderr.slice(0, 200),
        });
        throw err;
      }
    } finally {
      this.activeProc = null;
      notifyExit();
    }
  }

  /**
   * Spawn an acpx command. Drains stdout/stderr concurrently to avoid pipe-buffer deadlock.
   */
  private async trackedSpawn(
    cmd: string[],
    opts?: Parameters<typeof _spawnClientDeps.spawn>[1],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...opts });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    return { exitCode, stdout, stderr };
  }

  async close(options?: { forceTerminate?: boolean }): Promise<void> {
    // Kill in-flight prompt process first (if any)
    if (this.activeProc) {
      try {
        this.activeProc.kill(15); // SIGTERM
        getSafeLogger()?.debug("acp-adapter", `Killed active prompt process PID ${this.activeProc.pid}`);
      } catch {
        // Process may have already exited
      }
      this.activeProc = null;
    }

    const cmd = ["acpx", "--cwd", this.cwd, this.agentName, "sessions", "close", this.sessionName];
    getSafeLogger()?.debug("acp-adapter", `Closing session: ${this.sessionName}`);

    const { exitCode, stderr } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      getSafeLogger()?.warn("acp-adapter", "Failed to close session", {
        sessionName: this.sessionName,
        stderr: stderr.slice(0, 200),
      });
    }

    if (options?.forceTerminate) {
      try {
        await this.trackedSpawn(["acpx", this.agentName, "stop"]);
      } catch (err) {
        getSafeLogger()?.debug("acp-adapter", "acpx stop failed (swallowed)", { cause: String(err) });
      }
    }
  }

  async cancelActivePrompt(): Promise<void> {
    // Kill in-flight prompt process directly (faster than acpx cancel)
    if (this.activeProc) {
      try {
        this.activeProc.kill(15); // SIGTERM
        getSafeLogger()?.debug("acp-adapter", `Killed active prompt process PID ${this.activeProc.pid}`);
      } catch {
        // Process may have already exited
      }
    }

    const cmd = ["acpx", this.agentName, "cancel"];
    getSafeLogger()?.debug("acp-adapter", `Cancelling active prompt: ${this.sessionName}`);

    await this.trackedSpawn(cmd);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session ID parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse both ACP session IDs from `acpx --format json sessions ensure` stdout.
 *
 * acpx --format json outputs a JSON line:
 *   {"action":"session_ensured","created":true,"acpxRecordId":"<uuid>","acpxSessionId":"<uuid>","name":"<name>"}
 *
 * - `acpxRecordId` — stable record identifier, assigned at creation, never changes across reconnects.
 * - `acpxSessionId` — volatile Claude Code session ID, updated on each Claude Code reconnect.
 *
 * Returns an object with both IDs (undefined when not present in output).
 */
function parseSessionIds(stdout: string): { sessionId: string | undefined; recordId: string | undefined } {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const sessionId = parsed.acpxSessionId;
      const recordId = parsed.acpxRecordId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        return {
          sessionId,
          recordId: typeof recordId === "string" && recordId.length > 0 ? recordId : undefined,
        };
      }
    } catch {
      // not valid JSON — skip
    }
  }
  return { sessionId: undefined, recordId: undefined };
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
 * createSession() spawns: acpx <agent> sessions ensure --name <name>
 * loadSession() tries to resume an existing named session.
 */
export class SpawnAcpClient implements AcpClient {
  private readonly model: string;
  private readonly cwd: string;
  private readonly timeoutSeconds: number;
  private readonly promptRetries: number;
  private readonly env: Record<string, string | undefined>;
  private readonly onPidSpawned?: (pid: number) => void;
  private readonly onPidExited?: (pid: number) => void;

  constructor(
    cmdStr: string,
    cwd?: string,
    timeoutSeconds?: number,
    onPidSpawned?: (pid: number) => void,
    promptRetries?: number,
    onPidExited?: (pid: number) => void,
  ) {
    // Parse: "acpx --model <model> <agentName>"
    const parts = cmdStr.split(/\s+/);
    const modelIdx = parts.indexOf("--model");
    this.model = modelIdx >= 0 && parts[modelIdx + 1] ? parts[modelIdx + 1] : "default";
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
  }

  async start(): Promise<void> {
    // No-op — spawn-based client doesn't need upfront initialization
  }

  /**
   * Spawn an acpx command. Drains stdout/stderr concurrently to avoid pipe-buffer deadlock.
   */
  private async trackedSpawn(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    return { exitCode, stdout, stderr };
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
    return new SpawnAcpSession({
      agentName: opts.agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      promptRetries: this.promptRetries,
      permissionMode: opts.permissionMode,
      env: this.env,
      onPidSpawned: this.onPidSpawned,
      onPidExited: this.onPidExited,
      id: sessionId,
      recordId,
    });
  }

  async loadSession(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null> {
    // Try to ensure session exists — --format json surfaces the session UUID in stdout
    const cmd = ["acpx", "--cwd", this.cwd, "--format", "json", agentName, "sessions", "ensure", "--name", sessionName];

    const { exitCode, stdout } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      return null; // Session doesn't exist or can't be resumed
    }

    const { sessionId, recordId } = parseSessionIds(stdout);
    return new SpawnAcpSession({
      agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      promptRetries: this.promptRetries,
      permissionMode,
      env: this.env,
      onPidSpawned: this.onPidSpawned,
      onPidExited: this.onPidExited,
      id: sessionId,
      recordId,
    });
  }

  async closeSession(sessionName: string, agentName: string): Promise<void> {
    const cmd = ["acpx", "--cwd", this.cwd, agentName, "sessions", "close", sessionName];
    const { exitCode, stderr } = await this.trackedSpawn(cmd);
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
): AcpClient {
  return new SpawnAcpClient(cmdStr, cwd, timeoutSeconds, onPidSpawned, promptRetries, onPidExited);
}
