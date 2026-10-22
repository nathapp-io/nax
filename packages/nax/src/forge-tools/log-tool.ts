import type { ProviderTool } from "@nathapp/nax-agent";
import type { ForgeCheck, JobLogRead, PrRef } from "@/forge";
import { FORGE_LOG_DEFAULT_LINES, FORGE_LOG_LINE_CHARS, FORGE_LOG_MAX_LINES } from "./constants";
import { _forgeToolsDeps } from "./deps";
import { fitToolResult } from "./fit-result";
import { wrapForgeTool } from "./tool";
import type { ForgeReadBinding } from "./types";

const LOG_FIELDS = new Set(["check", "search", "from", "lines"]);
const LOG_INPUT_SCHEMA = {
  type: "object",
  required: ["check"],
  additionalProperties: false,
  properties: {
    check: {
      anyOf: [
        { type: "string", pattern: "^[0-9]+$" },
        { type: "integer", minimum: 0 },
      ],
    },
    search: { type: "string", minLength: 1 },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1, maximum: FORGE_LOG_MAX_LINES, default: FORGE_LOG_DEFAULT_LINES },
  },
};

function validateLogInput(input: Record<string, unknown>): string | undefined {
  const check = input.check;
  if (
    !(typeof check === "string" && /^\d+$/.test(check)) &&
    !(typeof check === "number" && Number.isSafeInteger(check) && check >= 0)
  )
    return "[forge-tools] check must be a string of digits or a non-negative safe integer";
  if ("search" in input && (typeof input.search !== "string" || input.search.length === 0))
    return "[forge-tools] search must be a non-empty string";
  if ("from" in input && (typeof input.from !== "number" || !Number.isSafeInteger(input.from) || input.from < 1))
    return "[forge-tools] from must be an integer >= 1";
  if (
    "lines" in input &&
    (typeof input.lines !== "number" ||
      !Number.isInteger(input.lines) ||
      input.lines < 1 ||
      input.lines > FORGE_LOG_MAX_LINES)
  )
    return `[forge-tools] lines must be an integer 1..${FORGE_LOG_MAX_LINES}`;
  const unknown = Object.keys(input).find((field) => !LOG_FIELDS.has(field));
  return unknown === undefined ? undefined : `[forge-tools] Unexpected field: ${unknown}`;
}

function tailResult(text: string, check: ForgeCheck, options: { count: number; maxBytes: number }): string {
  const { count, maxBytes } = options;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const start = Math.max(0, lines.length - count);
  const entries = lines
    .slice(start)
    .map((line, index) => `${start + index + 1}: ${line}`.slice(0, FORGE_LOG_LINE_CHARS));
  const partial =
    check.status === "in_progress"
      ? "job still running: this log is partial"
      : "job not completed: this log is partial";
  return fitToolResult(
    {
      header: ["Job log", `showing lines ${entries.length ? start + 1 : 0}-${lines.length} of ${lines.length}`],
      fencedHeader: [
        `check: ${check.id} | name: ${check.name} | status: ${check.status}${check.conclusion ? ` | conclusion: ${check.conclusion}` : ""}`,
      ],
      entries,
      footer: check.status === "completed" ? [] : [partial],
    },
    maxBytes,
    "end",
  );
}

/** PR-bound reads: fresh head authorization always precedes the provider-local cache. */
export function logTool(binding: ForgeReadBinding, resolveRef: () => Promise<PrRef>): ProviderTool {
  const completed = new Map<string, Promise<JobLogRead>>();
  const readLog = (ref: PrRef, check: ForgeCheck): Promise<JobLogRead> => {
    if (check.status !== "completed") return _forgeToolsDeps.readJobLog(ref, check.id, binding.deps, binding.cwd);
    const key = JSON.stringify([ref.forge, ref.host, ref.repo, ref.number, check.id]);
    let pending = completed.get(key);
    if (!pending) {
      pending = _forgeToolsDeps.readJobLog(ref, check.id, binding.deps, binding.cwd);
      completed.set(key, pending);
      // Unavailable logs may become readable later; do not retain failures.
      void pending.then(
        (result) => {
          if (!result.ok) completed.delete(key);
        },
        () => completed.delete(key),
      );
    }
    return pending;
  };
  return wrapForgeTool(
    {
      localName: "log",
      description: "Read the tail of a job log belonging to the bound PR's current head.",
      inputSchema: LOG_INPUT_SCHEMA,
      validate: validateLogInput,
      async read(ref, input, ctx) {
        const info = await _forgeToolsDeps.readPrInfo(ref, binding.deps, binding.cwd);
        const checks = await _forgeToolsDeps.listHeadChecks(ref, info.headSha, binding.deps, binding.cwd);
        const id = String(input.check);
        const check = checks.find((entry) => entry.id === id);
        if (!check)
          return {
            isError: true,
            content: `[forge-tools] Check ${id} is not on the PR's current head; use nax-forge__checks`,
          };
        if (!check.hasJobLog) return { isError: true, content: `[forge-tools] Check ${id} has no job log` };
        const result = await readLog(ref, check);
        if (!result.ok) return { isError: true, content: result.reason };
        const count = typeof input.lines === "number" ? input.lines : FORGE_LOG_DEFAULT_LINES;
        return { content: tailResult(result.text, check, { count, maxBytes: ctx.maxBytes }) };
      },
    },
    resolveRef,
  );
}
