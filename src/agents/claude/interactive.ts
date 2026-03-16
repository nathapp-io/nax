/**
 * Claude Code Agent - Interactive (TUI) Mode
 *
 * Handles terminal UI interactions with the Claude agent.
 */

import type { PidRegistry } from "../../execution/pid-registry";
import { getLogger } from "../../logger";
import type { AgentRunOptions, InteractiveRunOptions, PtyHandle } from "../types";
import { buildAllowedEnv } from "./execution";

/**
 * Run Claude agent in interactive (TTY) mode for TUI output.
 *
 * @param binary - Path to claude binary
 * @param options - Interactive run options
 * @param pidRegistry - PID registry for cleanup
 * @returns PTY handle for stdin/stdout/kill control
 */
export function runInteractiveMode(
  binary: string,
  options: InteractiveRunOptions,
  pidRegistry: PidRegistry,
): PtyHandle {
  const model = options.modelDef.model;
  const cmd = [binary, "--model", model, options.prompt];

  // BUN-001: Replaced node-pty with Bun.spawn (piped stdio).
  // runInteractive() is TUI-only and currently dormant in headless nax runs.
  // TERM + FORCE_COLOR preserve formatting output from Claude Code.
  const allowedEnv = buildAllowedEnv(options as unknown as AgentRunOptions);
  const proc = Bun.spawn(cmd, {
    cwd: options.workdir,
    env: { ...allowedEnv, TERM: "xterm-256color", FORCE_COLOR: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  pidRegistry.register(proc.pid).catch(() => {});

  // Stream stdout to onOutput callback
  (async () => {
    try {
      for await (const chunk of proc.stdout) {
        options.onOutput(Buffer.from(chunk));
      }
    } catch (err) {
      // BUG-21: Handle stream errors to avoid unhandled rejections
      getLogger()?.error("agent", "runInteractive stdout error", { err });
    }
  })();

  // Fire onExit when process completes
  proc.exited
    .then((code) => {
      pidRegistry.unregister(proc.pid).catch(() => {});
      options.onExit(code ?? 1);
    })
    .catch((err) => {
      // BUG-22: Guard against onExit or unregister throws
      getLogger()?.error("agent", "runInteractive exit error", { err });
    });

  return {
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
}
