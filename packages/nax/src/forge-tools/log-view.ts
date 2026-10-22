import type { ForgeCheck } from "@/forge";
import { FORGE_LOG_DEFAULT_LINES, FORGE_LOG_LINE_CHARS, FORGE_LOG_MAX_MATCHES } from "./constants";
import { fitToolResult } from "./fit-result";

/** Pure view selection over full, already-sanitized log lines. Inputs are validated by the tool. */
function selectView(lines: string[], input: { search?: string; from?: number; lines?: number }) {
  if (input.search !== undefined) {
    const needle = input.search.toLowerCase();
    const indices: number[] = [];
    let matches = 0;
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue;
      matches++;
      if (indices.length < FORGE_LOG_MAX_MATCHES) indices.push(index);
    }
    return { indices, keep: "start" as const, summary: [`${indices.length} of ${matches} matches`] };
  }
  const count = input.lines ?? FORGE_LOG_DEFAULT_LINES;
  const start = input.from === undefined ? Math.max(0, lines.length - count) : input.from - 1;
  const length = Math.max(0, Math.min(count, lines.length - start));
  return {
    indices: Array.from({ length }, (_, i) => start + i),
    keep: input.from === undefined ? ("end" as const) : ("start" as const),
    summary: [],
  };
}

/** Render numbered entries, then fit whole entries through the shared safe fence renderer. */
export function logViewResult(
  text: string,
  check: ForgeCheck,
  options: { search?: string; from?: number; lines?: number; maxBytes: number },
): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const view = selectView(lines, options);
  const first = view.indices.at(0);
  const last = view.indices.at(-1);
  const entries = view.indices.map((index) => `${index + 1}: ${lines[index]}`.slice(0, FORGE_LOG_LINE_CHARS));
  const partial =
    check.status === "in_progress"
      ? "job still running: this log is partial"
      : "job not completed: this log is partial";
  return fitToolResult(
    {
      header: [
        "Job log",
        `showing lines ${first === undefined ? 0 : first + 1}-${last === undefined ? 0 : last + 1} of ${lines.length}`,
        ...view.summary,
      ],
      fencedHeader: {
        identity: `check: ${check.id} | status: ${check.status}`,
        detail: ` | name: ${check.name}${check.conclusion ? ` | conclusion: ${check.conclusion}` : ""}`,
      },
      entryPrefix: (entry) => entry.slice(0, entry.indexOf(": ") + 2),
      entries,
      footer: check.status === "completed" ? [] : [partial],
    },
    options.maxBytes,
    view.keep,
  );
}
