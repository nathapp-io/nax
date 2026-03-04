/**
 * usePty hook — manages Bun.spawn subprocess lifecycle for agent sessions (BUN-001).
 *
 * Spawns, buffers output, handles resize, and cleanup for PTY processes.
 */

import { useCallback, useEffect, useState } from "react";
import type { PtyHandle } from "../../agents/types";

/**
 * Options for spawning PTY process.
 */
export interface PtySpawnOptions {
  /** Command to execute (e.g., "claude") */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Terminal columns (default: 80) */
  cols?: number;
  /** Terminal rows (default: 24) */
  rows?: number;
}

/**
 * PTY state managed by the hook.
 */
export interface PtyState {
  /** Output lines buffered from PTY */
  outputLines: string[];
  /** Whether PTY process is running */
  isRunning: boolean;
  /** Exit code (if process exited) */
  exitCode?: number;
}

/**
 * Maximum number of output lines to buffer.
 *
 * Prevents memory bloat from long-running PTY sessions.
 */
const MAX_PTY_BUFFER_LINES = 500;

/**
 * Maximum length per line in characters.
 *
 * Prevents memory exhaustion from single extremely long lines.
 */
const MAX_LINE_LENGTH = 10_000;

/**
 * Hook for managing PTY lifecycle.
 *
 * Spawns a PTY process, buffers output, and provides a handle for input/resize/kill.
 *
 * @param options - PTY spawn options (null to skip spawning)
 * @returns PTY state and handle
 *
 * @example
 * ```tsx
 * const { outputLines, isRunning, handle } = usePty({
 *   command: "claude",
 *   args: ["--model", "claude-sonnet-4.5"],
 *   cwd: "/project",
 * });
 *
 * // Write input to PTY
 * handle?.write("y\n");
 *
 * // Render output
 * <AgentPanel outputLines={outputLines} />
 * ```
 */
export function usePty(options: PtySpawnOptions | null): PtyState & { handle: PtyHandle | null } {
  const [state, setState] = useState<PtyState>(() => ({
    outputLines: [],
    isRunning: false,
  }));

  const [handle, setHandle] = useState<PtyHandle | null>(null);
  const [ptyProcess, setPtyProcess] = useState<ReturnType<typeof Bun.spawn> | null>(null);

  // Spawn PTY process
  useEffect(() => {
    if (!options) {
      return;
    }

    // BUN-001: Replaced node-pty with Bun.spawn (piped stdio).
    // TERM + FORCE_COLOR preserve Claude Code output formatting.
    const proc = Bun.spawn([options.command, ...(options.args || [])], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env, TERM: "xterm-256color", FORCE_COLOR: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit", // MEM-1: Inherit stderr to avoid blocking on unread pipe
    });

    setPtyProcess(proc);
    setState((prev) => ({ ...prev, isRunning: true }));

    // Stream stdout line-by-line into state buffer
    (async () => {
      let currentLine = "";
      for await (const chunk of proc.stdout) {
        const data = Buffer.from(chunk).toString();
        const lines = (currentLine + data).split("\n");
        currentLine = lines.pop() || "";

        if (currentLine.length > MAX_LINE_LENGTH) {
          currentLine = currentLine.slice(-MAX_LINE_LENGTH);
        }

        if (lines.length > 0) {
          const truncatedLines = lines.map((line) =>
            line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
          );
          setState((prev) => {
            const newLines = [...prev.outputLines, ...truncatedLines];
            const trimmed = newLines.length > MAX_PTY_BUFFER_LINES ? newLines.slice(-MAX_PTY_BUFFER_LINES) : newLines;
            return { ...prev, outputLines: trimmed };
          });
        }
      }
    })();

    // Handle exit
    proc.exited
      .then((code) => {
        setState((prev) => ({ ...prev, isRunning: false, exitCode: code ?? undefined }));
      })
      .catch(() => {
        // BUG-22: Guard against setState throws (e.g. on unmount)
        setState((prev) => ({ ...prev, isRunning: false }));
      });

    // Create handle
    const ptyHandle: PtyHandle = {
      write: (data: string) => {
        proc.stdin.write(data);
      },
      resize: (_cols: number, _rows: number) => {
        /* no-op: Bun.spawn has no PTY resize */
      },
      kill: () => {
        proc.kill();
      },
      pid: proc.pid,
    };

    setHandle(ptyHandle);

    // Cleanup on unmount
    return () => {
      proc.kill();
    };
  }, [options]);

  // Handle terminal resize
  // resize is a no-op with Bun.spawn (no PTY) — kept for API compatibility
  const handleResize = useCallback((_cols: number, _rows: number) => {
    // BUN-001: no-op — Bun.spawn does not support PTY resize
  }, []);

  useEffect(() => {
    const onResize = () => {
      const cols = process.stdout.columns ?? 80;
      const rows = process.stdout.rows ?? 24;
      handleResize(cols, rows);
    };

    process.stdout.on("resize", onResize);

    return () => {
      process.stdout.off("resize", onResize);
    };
  }, [handleResize]);

  return { ...state, handle };
}
