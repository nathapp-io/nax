import type { AgentsRunResult } from "@/cli/agents-run-exec";

export interface AgentsRunOutput {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode: 0 | 1;
}

/** Format a run result without performing any writes. */
export function agentsRunOutput(result: AgentsRunResult, json: boolean): AgentsRunOutput {
  const exitCode = result.status === "completed" ? 0 : 1;
  if (json) return { stdout: `${JSON.stringify(result)}\n`, exitCode };

  const deniedAsks = result.deniedAsks.map(formatDeniedAsk).join("");
  if (result.status === "completed") {
    return {
      stdout: `${result.output}\n`,
      ...(deniedAsks.length > 0 ? { stderr: deniedAsks } : {}),
      exitCode,
    };
  }
  return { stderr: `${result.output}\n${deniedAsks}`, exitCode };
}

function formatDeniedAsk(ask: AgentsRunResult["deniedAsks"][number]): string {
  return ask.kind === "approval"
    ? `[agents run] denied ${ask.tool}: ${ask.summary}\n`
    : `[agents run] unanswered question: ${ask.text}\n`;
}
