/**
 * usePty hook — manages node-pty lifecycle for agent PTY sessions.
 *
 * Spawns, buffers output, handles resize, and cleanup for PTY processes.
 */

import { useState, useEffect, useCallback } from "react";
import type * as pty from "node-pty";

/**
 * PTY handle interface for managing spawned PTY process.
 *
 * Provides methods to write input, resize terminal, and kill process.
 */
export interface PtyHandle {
  /** Write input to PTY stdin */
  write(data: string): void;
  /** Resize PTY terminal */
  resize(cols: number, rows: number): void;
  /** Kill PTY process */
  kill(): void;
  /** Process ID */
  pid: number;
}

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
  const [ptyProcess, setPtyProcess] = useState<pty.IPty | null>(null);

  // Spawn PTY process
  useEffect(() => {
    if (!options) {
      return;
    }

    // Lazy load node-pty (only when needed)
    let nodePty: typeof pty;
    try {
      nodePty = require("node-pty");
    } catch (error) {
      console.error("[usePty] node-pty not available:", error);
      return;
    }

    const ptyProc = nodePty.spawn(options.command, options.args || [], {
      name: "xterm-256color",
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        ...options.env,
      },
    });

    setPtyProcess(ptyProc);
    setState((prev) => ({ ...prev, isRunning: true }));

    // Buffer output line-by-line
    let currentLine = "";
    ptyProc.onData((data) => {
      const lines = (currentLine + data).split("\n");
      currentLine = lines.pop() || "";

      if (lines.length > 0) {
        setState((prev) => {
          const newLines = [...prev.outputLines, ...lines];
          // Keep only last N lines
          const trimmed = newLines.length > MAX_PTY_BUFFER_LINES
            ? newLines.slice(-MAX_PTY_BUFFER_LINES)
            : newLines;
          return { ...prev, outputLines: trimmed };
        });
      }
    });

    // Handle exit
    ptyProc.onExit((event) => {
      setState((prev) => ({
        ...prev,
        isRunning: false,
        exitCode: event.exitCode,
      }));
    });

    // Create handle
    const ptyHandle: PtyHandle = {
      write: (data: string) => ptyProc.write(data),
      resize: (cols: number, rows: number) => ptyProc.resize(cols, rows),
      kill: () => ptyProc.kill(),
      pid: ptyProc.pid,
    };

    setHandle(ptyHandle);

    // Cleanup on unmount
    return () => {
      if (ptyProc) {
        ptyProc.kill();
      }
    };
  }, [options]);

  // Handle terminal resize
  const handleResize = useCallback((cols: number, rows: number) => {
    if (ptyProcess) {
      ptyProcess.resize(cols, rows);
    }
  }, [ptyProcess]);

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
