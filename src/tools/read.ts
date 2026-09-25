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
 *
 * Self-cap at whole-line model caps (US-002): when today's body overflows the
 * line or byte ceiling, the tool cuts at the largest whole-line boundary that
 * still fits and appends a single trailer naming the delivered range. The
 * after_tool policy (`applyModelTruncationPolicy`) is the unconditional
 * backstop — a result that already fits every cap passes through it untouched
 * (its within-cap contract), so no spill file is written for it. The cap
 * footer replaces the limit-stop footer when it fires; a result never carries
 * both.
 */

import { readPrefix } from "@/utils/bounded-io";
import { applyCapCut, limitStopFooter, shouldAppendLimitStopFooter } from "./read-continuation";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";
import { MODEL_MAX_BYTES, MODEL_MAX_LINES, READ_CEILING, splitModelLines } from "./truncate";

/** Range arguments models invent instead of offset/limit -- rejected by name, never silently dropped. */
const UNSUPPORTED_RANGE_ALIASES = ["start_line", "end_line", "start", "end", "line", "lineEnd", "size"] as const;

/** A positive integer, or an error string naming which constraint failed. */
function parsePositiveInt(value: unknown, field: string): number | string {
  if (typeof value !== "number" || !Number.isInteger(value)) return `${field} must be an integer`;
  if (value < 1) return `${field} must be >= 1`;
  return value;
}

/** Count lines in a UTF-8 string. Empty string returns 0. Trailing newline is not a line. */
function countLines(prefix: string): number {
  if (prefix === "") return 0;
  const trimmed = prefix.endsWith("\n") ? prefix.slice(0, -1) : prefix;
  return trimmed.split("\n").length;
}

export const readTool: CodingTool = {
  name: "Read",
  description:
    "Read a UTF-8 text file from the repository. Paths are relative to the repository root. " +
    "Optionally pass offset (1-based line number to start from) and/or limit (maximum number of " +
    "lines to return) to read a slice instead of the whole file. " +
    "Use Read to examine files instead of cat, sed, head, tail or awk in Bash. " +
    "A read that stops before the end of the file ends with a line naming the offset to continue from. " +
    "For a large file, read the part you need with offset/limit; when you need the whole file, continue with offset until complete. " +
    `Output is capped at ${MODEL_MAX_LINES} lines or ${MODEL_MAX_BYTES} bytes.`,
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
        // Leading [N lines] header so an agent has a way to count the lines it
        // is reading. The count comes from the maxBytes prefix, not a second,
        // larger read: readPrefix asks for maxBytes + 1 and the overshoot byte
        // is what tells us the prefix hit the ceiling -- in that case the count
        // is a floor and we mark it with '+'. The ranged branch reads with
        // maxFileBytes and compares against maxFileBytes for the same reason.
        const readCeiling = ctx.readCeiling ?? READ_CEILING;
        const prefix = await readPrefix(target, readCeiling);
        const bounded = Buffer.byteLength(prefix, "utf8") > readCeiling;
        const lineCount = countLines(prefix);
        const totalLabel = bounded ? `${lineCount}+` : `${lineCount}`;
        const header = `[${totalLabel} lines]`;
        // US-002: the whole-file prefix is shaped at the model-facing caps
        // before being handed to the runtime. Today's unshaped body is
        // `header + (prefix when non-empty)`. The cap cut tries the largest
        // k such that `header + first k lines + cap footer` fits both budgets;
        // when no k fits, today's body passes through unchanged and the
        // after_tool policy shapes it.
        const unshaped = prefix === "" ? header : `${header}\n${prefix}`;
        const result = applyCapCut({
          header,
          lines: splitModelLines(prefix),
          firstLine: 1,
          totalLabel,
          limitStopFooter: "",
          unshapedBody: unshaped,
          maxBytes: ctx.maxBytes,
          maxLines: MODEL_MAX_LINES,
        });
        return { content: result.content };
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
      const totalLines = countLines(body);
      const totalLabel = bounded ? `${totalLines}+` : `${totalLines}`;

      if (offset > totalLines) {
        return {
          content: bounded
            ? `offset ${offset} is past the first ${totalLines} lines, which is all that could be read within the ${ctx.maxFileBytes}-byte ceiling`
            : `offset ${offset} is past the end of the file -- it has ${totalLines} lines`,
        };
      }

      const lines = splitModelLines(body);
      const startIndex = offset - 1;
      const endLine = limit === undefined ? totalLines : Math.min(startIndex + limit, totalLines);
      const selected = lines.slice(startIndex, endLine).join("\n");
      const headerLine = `[lines ${offset}-${endLine} of ${totalLabel}]`;
      // US-001: when a `limit` cut the slice short of the file's known line
      // count, append a single trailer that names the continuation offset.
      // The helper hides the predicate (limit given AND endLine < totalLines)
      // and the `+`-on-floor rule, both of which are easy to drift apart from
      // the header if inlined.
      const limitStop = shouldAppendLimitStopFooter(limit !== undefined, endLine, totalLines)
        ? limitStopFooter({
            nextOffset: endLine + 1,
            totalIsFloor: bounded,
            endLine,
            totalLines,
          })
        : "";
      // US-002: shape today's body at the model-facing caps. The cap cut
      // replaces the limit-stop footer when it fires; when no whole line
      // fits with the header and cap footer, today's body is returned
      // unchanged (plus the limit-stop footer from rule 1 if it applied),
      // and the after_tool policy then shapes it.
      const unshapedBody = `${headerLine}\n${selected}`;
      const result = applyCapCut({
        header: headerLine,
        lines: lines.slice(startIndex, endLine),
        firstLine: offset,
        totalLabel,
        limitStopFooter: limitStop,
        unshapedBody,
        maxBytes: ctx.maxBytes,
        maxLines: MODEL_MAX_LINES,
      });
      return { content: result.content };
    } catch (err) {
      // An unreadable file is a tool ERROR the model can react to, never a
      // denial: the policy already said yes.
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
