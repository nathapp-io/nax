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

import type { PidRegistry } from "../../execution/pid-registry";
import { getSafeLogger } from "../../logger";
import { typedSpawn } from "../../utils/bun-deps";
import { buildAllowedEnv } from "../shared/env";
import type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter";
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
class SpawnAcpSession implements AcpSession {
  private readonly agentName: string;
  private readonly sessionName: string;
  private readonly cwd: string;
  private readonly model: string;
  private readonly timeoutSeconds: number;
  private readonly permissionMode: string;
  private readonly env: Record<string, string | undefined>;
  private readonly pidRegistry?: PidRegistry;
  private activeProc: { pid: number; kill(signal?: number): void } | null = null;

  constructor(opts: {
    agentName: string;
    sessionName: string;
    cwd: string;
    model: string;
    timeoutSeconds: number;
    permissionMode: string;
    env: Record<string, string | undefined>;
    pidRegistry?: PidRegistry;
  }) {
    this.agentName = opts.agentName;
    this.sessionName = opts.sessionName;
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.timeoutSeconds = opts.timeoutSeconds;
    this.permissionMode = opts.permissionMode;
    this.env = opts.env;
    this.pidRegistry = opts.pidRegistry;
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
    await this.pidRegistry?.register(processPid);

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
        getSafeLogger()?.warn("acp-adapter", `Session prompt exited with code ${exitCode}`, {
          exitCode,
          stderr: stderr.slice(0, 500),
        });
        // Return error response so the adapter can handle it
        return {
          messages: [{ role: "assistant", content: stderr || `Exit code ${exitCode}` }],
          stopReason: "error",
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
      await this.pidRegistry?.unregister(processPid);
    }
  }

  /**
   * Spawn an acpx command with PID tracking (register before await, unregister in finally).
   * Drains stdout/stderr concurrently to avoid pipe-buffer deadlock.
   */
  private async trackedSpawn(
    cmd: string[],
    opts?: Parameters<typeof _spawnClientDeps.spawn>[1],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe", ...opts });
    const pid = proc.pid;
    await this.pidRegistry?.register(pid);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => ""),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      await this.pidRegistry?.unregister(pid);
    }
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
  private readonly agentName: string;
  private readonly model: string;
  private readonly cwd: string;
  private readonly timeoutSeconds: number;
  private readonly env: Record<string, string | undefined>;
  private readonly pidRegistry?: PidRegistry;

  constructor(cmdStr: string, cwd?: string, timeoutSeconds?: number, pidRegistry?: PidRegistry) {
    // Parse: "acpx --model <model> <agentName>"
    const parts = cmdStr.split(/\s+/);
    const modelIdx = parts.indexOf("--model");
    this.model = modelIdx >= 0 && parts[modelIdx + 1] ? parts[modelIdx + 1] : "default";
    // Agent name is the last non-flag token — must be present and not a flag
    const lastToken = parts[parts.length - 1];
    if (!lastToken || lastToken.startsWith("-")) {
      throw new Error(`[acp-adapter] Could not parse agentName from cmdStr: "${cmdStr}"`);
    }
    this.agentName = lastToken;
    this.cwd = cwd || process.cwd();
    this.timeoutSeconds = timeoutSeconds || 1800;
    this.env = buildAllowedEnv();
    this.pidRegistry = pidRegistry;
  }

  async start(): Promise<void> {
    // No-op — spawn-based client doesn't need upfront initialization
  }

  /**
   * Spawn an acpx command with PID tracking (register before await, unregister in finally).
   * Drains stdout/stderr concurrently to avoid pipe-buffer deadlock.
   */
  private async trackedSpawn(cmd: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const pid = proc.pid;
    await this.pidRegistry?.register(pid);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text().catch(() => ""),
        new Response(proc.stderr).text().catch(() => ""),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      await this.pidRegistry?.unregister(pid);
    }
  }

  async createSession(opts: {
    agentName: string;
    permissionMode: string;
    sessionName?: string;
  }): Promise<AcpSession> {
    const sessionName = opts.sessionName || `nax-${Date.now()}`;

    // Ensure session exists via CLI
    const cmd = ["acpx", "--cwd", this.cwd, opts.agentName, "sessions", "ensure", "--name", sessionName];
    getSafeLogger()?.debug("acp-adapter", `Ensuring session: ${sessionName}`);

    const { exitCode, stderr } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      throw new Error(`[acp-adapter] Failed to create session: ${stderr || `exit code ${exitCode}`}`);
    }

    return new SpawnAcpSession({
      agentName: opts.agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      permissionMode: opts.permissionMode,
      env: this.env,
      pidRegistry: this.pidRegistry,
    });
  }

  async loadSession(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null> {
    // Try to ensure session exists — if it does, acpx returns success
    const cmd = ["acpx", "--cwd", this.cwd, agentName, "sessions", "ensure", "--name", sessionName];

    const { exitCode } = await this.trackedSpawn(cmd);

    if (exitCode !== 0) {
      return null; // Session doesn't exist or can't be resumed
    }

    return new SpawnAcpSession({
      agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      permissionMode,
      env: this.env,
      pidRegistry: this.pidRegistry,
    });
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
  cwd?: string,
  timeoutSeconds?: number,
  pidRegistry?: PidRegistry,
): AcpClient {
  return new SpawnAcpClient(cmdStr, cwd, timeoutSeconds, pidRegistry);
}
