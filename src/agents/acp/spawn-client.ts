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
import type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter";
import { parseAcpxJsonOutput } from "./parser";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ACPX_WATCHDOG_BUFFER_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Spawn helper (injectable for future testing if needed)
// ─────────────────────────────────────────────────────────────────────────────

export const _spawnClientDeps = {
  spawn(
    cmd: string[],
    opts: {
      cwd?: string;
      stdin?: "pipe" | "inherit";
      stdout: "pipe";
      stderr: "pipe";
      env?: Record<string, string | undefined>;
    },
  ): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: { write(data: string | Uint8Array): number; end(): void; flush(): void };
    exited: Promise<number>;
    pid: number;
    kill(signal?: number): void;
  } {
    return Bun.spawn(cmd, opts) as unknown as ReturnType<typeof _spawnClientDeps.spawn>;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Env builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build allowed environment variables for spawned acpx processes.
 * SEC-4: Only pass essential env vars to prevent leaking sensitive data.
 */
function buildAllowedEnv(extraEnv?: Record<string, string | undefined>): Record<string, string | undefined> {
  const allowed: Record<string, string | undefined> = {};

  const essentialVars = ["PATH", "HOME", "TMPDIR", "NODE_ENV", "USER", "LOGNAME"];
  for (const varName of essentialVars) {
    if (process.env[varName]) allowed[varName] = process.env[varName];
  }

  const apiKeyVars = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDE_API_KEY"];
  for (const varName of apiKeyVars) {
    if (process.env[varName]) allowed[varName] = process.env[varName];
  }

  const allowedPrefixes = ["CLAUDE_", "NAX_", "CLAW_", "TURBO_", "ACPX_", "CODEX_", "GEMINI_"];
  for (const [key, value] of Object.entries(process.env)) {
    if (allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
      allowed[key] = value;
    }
  }

  if (extraEnv) Object.assign(allowed, extraEnv);
  return allowed;
}

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
      proc.stdin.write(text);
      proc.stdin.end();

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        getSafeLogger()?.warn("acp-adapter", `Session prompt exited with code ${exitCode}`, {
          stderr: stderr.slice(0, 200),
        });
        // Return error response so the adapter can handle it
        return {
          messages: [{ role: "assistant", content: stderr || `Exit code ${exitCode}` }],
          stopReason: "error",
        };
      }

      try {
        const parsed = parseAcpxJsonOutput(stdout);
        return {
          messages: [{ role: "assistant", content: parsed.text || "" }],
          stopReason: "end_turn",
          cumulative_token_usage: parsed.tokenUsage,
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

  async close(): Promise<void> {
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

    const cmd = ["acpx", this.agentName, "sessions", "close", this.sessionName];
    getSafeLogger()?.debug("acp-adapter", `Closing session: ${this.sessionName}`);

    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      getSafeLogger()?.warn("acp-adapter", "Failed to close session", {
        sessionName: this.sessionName,
        stderr: stderr.slice(0, 200),
      });
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

    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
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
  private readonly permissionMode: string;
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
    this.permissionMode = "approve-reads";
    this.env = buildAllowedEnv();
    this.pidRegistry = pidRegistry;
  }

  async start(): Promise<void> {
    // No-op — spawn-based client doesn't need upfront initialization
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

    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
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

  async loadSession(sessionName: string, agentName: string): Promise<AcpSession | null> {
    // Try to ensure session exists — if it does, acpx returns success
    const cmd = ["acpx", "--cwd", this.cwd, agentName, "sessions", "ensure", "--name", sessionName];

    const proc = _spawnClientDeps.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return null; // Session doesn't exist or can't be resumed
    }

    return new SpawnAcpSession({
      agentName,
      sessionName,
      cwd: this.cwd,
      model: this.model,
      timeoutSeconds: this.timeoutSeconds,
      permissionMode: this.permissionMode,
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
