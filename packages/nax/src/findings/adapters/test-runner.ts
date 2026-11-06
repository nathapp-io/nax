import type { Finding } from "../types";

/**
 * Synth-finding for the `execution-failed` gate state: the runner exited
 * non-zero but the parser found 0 structured test failures (e.g. config
 * crash, missing dependency, wrong cwd, runner segfault). Without this,
 * the rectifier no-ops on 0 findings and the orchestrator escalates
 * without dispatching the implementer.
 *
 * Carries the actual command + exit code + a tail of the runner output so
 * the implementer prompt has concrete repair context.
 */
export function executionFailureToFinding(params: {
  command: string;
  exitCode?: number;
  output: string;
  packageDir?: string;
  cwd?: string;
}): Finding {
  const tail = tailLines(params.output, 40);
  const exitStr = params.exitCode !== undefined ? ` (exit ${params.exitCode})` : "";
  const message = `Test runner exited non-zero without structured failures${exitStr}. Command: \`${params.command}\`\n\n--- runner output (last 40 lines) ---\n${tail}`;
  return {
    source: "test-runner",
    severity: "error",
    category: "execution-failed",
    message,
    fixTarget: "source",
    meta: {
      command: params.command,
      exitCode: params.exitCode,
      packageDir: params.packageDir,
      cwd: params.cwd,
    },
  };
}

function tailLines(s: string, n: number): string {
  if (!s) return "(no output)";
  const lines = s.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}
