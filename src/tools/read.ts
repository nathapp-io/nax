/**
 * Read one file, already resolved and approved by the policy.
 *
 * The tool never resolves a path itself: it uses ctx.resolvedPaths, which the
 * policy produced. That is what keeps containment in one seam.
 *
 * offset/limit (#1923): models constantly ask for a line range under six
 * different invented spellings, and every one of them was silently discarded
 * because `run`'s input parameter was unused. offset/limit is the spelling
 * they reach for most (144 of 187 observed range arguments), so that is the
 * only shape honoured -- every other spelling is rejected by name rather than
 * silently dropped, the same principle policy.ts uses for a denied argv: name
 * the supported forms instead of a bare refusal.
 */

import { readPrefix } from "@/utils/bounded-io";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

/** Range arguments models invent instead of offset/limit -- rejected by name, never silently dropped. */
const UNSUPPORTED_RANGE_ALIASES = ["start_line", "end_line", "start", "end", "line", "lineEnd", "size"] as const;

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

/** A positive integer, or an error string naming which constraint failed. */
function parsePositiveInt(value: unknown, field: string): number | string {
  if (typeof value !== "number" || !Number.isInteger(value)) return `${field} must be an integer`;
  if (value < 1) return `${field} must be >= 1`;
  return value;
}

export const readTool: CodingTool = {
  name: "Read",
  description:
    "Read a UTF-8 text file from the repository. Paths are relative to the repository root. " +
    "Optionally pass offset (1-based line number to start from) and/or limit (maximum number of " +
    "lines to return) to read a slice instead of the whole file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from" },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return" },
    },
    required: ["path"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };

    const usedAlias = UNSUPPORTED_RANGE_ALIASES.find((alias) => input[alias] !== undefined);
    if (usedAlias !== undefined) {
      return {
        content: `"${usedAlias}" is not a supported Read argument -- use offset (1-based line number) and/or limit (line count) instead`,
        isError: true,
      };
    }

    const hasOffset = input.offset !== undefined;
    const hasLimit = input.limit !== undefined;

    try {
      if (!hasOffset && !hasLimit) {
        // Byte-identical to pre-#1923 behaviour: a prefix, not the file, since
        // the result is truncated to the same ceiling either way.
        return { content: truncate(await readPrefix(target, ctx.maxBytes), ctx.maxBytes) };
      }

      let offset = 1;
      if (hasOffset) {
        const parsed = parsePositiveInt(input.offset, "offset");
        if (typeof parsed === "string") return { content: parsed, isError: true };
        offset = parsed;
      }
      let limit: number | undefined;
      if (hasLimit) {
        const parsed = parsePositiveInt(input.limit, "limit");
        if (typeof parsed === "string") return { content: parsed, isError: true };
        limit = parsed;
      }

      // Read up to maxFileBytes, not maxBytes: the requested range may start
      // past the display ceiling, and we still need to reach it to slice.
      const body = await readPrefix(target, ctx.maxFileBytes);
      // readPrefix asks for maxFileBytes + 1, so overshooting the ceiling is how
      // we know the file continues past what we read. The line count is then a
      // floor, not a total, and must not be reported as one -- claiming a false
      // total to the model is the same class of defect #1923 is fixing.
      const bounded = Buffer.byteLength(body, "utf8") > ctx.maxFileBytes;
      const trailingNewline = body.endsWith("\n");
      const lines = trailingNewline ? body.slice(0, -1).split("\n") : body.split("\n");
      const totalLines = lines.length;
      const totalLabel = bounded ? `${totalLines}+` : `${totalLines}`;

      if (offset > totalLines) {
        return {
          content: bounded
            ? `offset ${offset} is past the first ${totalLines} lines, which is all that could be read within the ${ctx.maxFileBytes}-byte ceiling`
            : `offset ${offset} is past the end of the file -- it has ${totalLines} lines`,
        };
      }

      const startIndex = offset - 1;
      const endLine = limit === undefined ? totalLines : Math.min(startIndex + limit, totalLines);
      const selected = lines.slice(startIndex, endLine).join("\n");
      const header = `[lines ${offset}-${endLine} of ${totalLabel}]\n`;
      return { content: truncate(`${header}${selected}`, ctx.maxBytes) };
    } catch (err) {
      // An unreadable file is a tool ERROR the model can react to, never a
      // denial: the policy already said yes.
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
