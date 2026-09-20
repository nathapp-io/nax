/**
 * Confined write/read/list tools for an agent-owned throwaway directory.
 *
 * Three small tools (ScratchpadWrite / ScratchpadRead / ScratchpadList) that
 * let a session keep notes, command output and intermediate lists between
 * calls without ever writing anything the policy could later attribute to
 * the run. Containment is the load-bearing seam: every tool declares
 * `scope.confineTo = SCRATCHPAD_DIR`, so the policy runs `resolveWithin`
 * against `<root>/<confineTo>` instead of the repository root. A `..`
 * traversal leaves the confined directory, returns null from `resolveWithin`,
 * and the policy reports `breach: true` (US-001). The tools themselves never
 * resolve a path -- they consume `ctx.resolvedPaths[0]` only, so the policy
 * stays the single seam.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { resolveWithin } from "./policy";
import { readFileSlice } from "./read-file";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";
import { READ_CEILING } from "./truncate";

/** The canonical scratchpad path, written into the policy as `scope.confineTo`. */
export const SCRATCHPAD_DIR = ".nax/scratchpad";

/**
 * Match cap for ScratchpadList. Mirrors `glob.ts`'s `MAX_MATCHES` -- a
 * long-running session accumulates throwaway files by design, so an
 * unbounded scan would feed an arbitrarily large listing back into model
 * context, bypassing the `ctx.maxBytes` ceiling every other content-
 * returning tool honours.
 */
const MAX_MATCHES = 500;

/**
 * Slice the first `maxBytes` bytes of a UTF-8 buffer, backing up to the last
 * codepoint boundary if the raw slice would land mid-codepoint.
 *
 * A byte-aligned slice that ends inside a multi-byte codepoint decodes with
 * a U+FFFD replacement character (3 bytes), which can push the resulting
 * string PAST the byte budget the slice was taken from -- exactly the
 * contract AC12 pins ("at most maxBytes bytes"). Backing up one byte at a
 * time lands on a clean codepoint boundary within four attempts (max UTF-8
 * codepoint length), keeping the decoded byte length under control.
 */
function sliceByteBudget(buf: Buffer, maxBytes: number): string {
  const end = Math.min(buf.length, maxBytes);
  for (let cut = end; cut > 0; cut -= 1) {
    const candidate = buf.subarray(0, cut).toString("utf8");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) return candidate;
  }
  return "";
}

/** Truncate content to `maxBytes` with a marker, preserving the byte ceiling. */
function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  const buf = Buffer.from(body, "utf8");
  const suffix = `\n... [truncated at ${maxBytes} bytes]`;
  const suffixLen = Buffer.byteLength(suffix, "utf8");
  // Ceiling too small to fit the marker -- return a plain slice with no suffix
  // rather than exceeding maxBytes. sliceByteBudget backs up to the last
  // codepoint boundary so a multi-byte UTF-8 source does not produce a
  // U+FFFD-stuffed string that overshoots the budget.
  if (suffixLen >= maxBytes) return sliceByteBudget(buf, maxBytes);
  // Reserve space for the suffix so head + suffix stays within maxBytes.
  // The same boundary discipline applies here: the head is byte-fitted to
  // `budget` before the marker is appended, so the combined result never
  // exceeds maxBytes even when `budget` lands mid-codepoint.
  const budget = maxBytes - suffixLen;
  return `${sliceByteBudget(buf, budget)}${suffix}`;
}

export const scratchpadWriteTool: CodingTool = {
  name: "ScratchpadWrite",
  description:
    "Write a throwaway file to your scratchpad at .nax/scratchpad/. Use it for notes to yourself, command output you want to re-read, or intermediate lists. It is never committed and is wiped at the start of each run. Paths are relative to the scratchpad and cannot reach the repository.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the scratchpad directory" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  scope: { pathFields: ["path"], confineTo: SCRATCHPAD_DIR },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const content = input.content;
    if (typeof content !== "string") return { content: "content must be a string", isError: true };

    // Check the ceiling BEFORE any directory or file creation, so a refused
    // write leaves no empty file at the target. This is the load-bearing
    // property the AC11 boundary pins.
    const size = Buffer.byteLength(content, "utf8");
    if (size > ctx.maxFileBytes) {
      return {
        content: `content is ${size} bytes, which exceeds the ${ctx.maxFileBytes}-byte file ceiling`,
        isError: true,
      };
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { content: `wrote ${size} bytes` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};

export const scratchpadReadTool: CodingTool = {
  name: "ScratchpadRead",
  description:
    "Read a throwaway file from your scratchpad at .nax/scratchpad/. Paths are relative to the scratchpad. Use it to re-read notes, command output and intermediate lists you wrote with ScratchpadWrite -- including the output a truncated tool result spilled there. Optionally pass offset (1-based line number to start from) and/or limit (maximum number of lines to return) to page through a body too large to read at once.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the scratchpad directory" },
      offset: { type: "integer", minimum: 1, description: "1-based line number to start reading from" },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return" },
    },
    required: ["path"],
  },
  scope: { pathFields: ["path"], confineTo: SCRATCHPAD_DIR },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const requestedPath = typeof input.path === "string" ? input.path : "<path>";
    const rawOffset = input.offset;
    if (rawOffset !== undefined && typeof rawOffset !== "number") {
      return { content: "offset must be an integer", isError: true };
    }
    const rawLimit = input.limit;
    if (rawLimit !== undefined && typeof rawLimit !== "number") {
      return { content: "limit must be an integer", isError: true };
    }
    const offset = rawOffset;
    const limit = rawLimit;
    try {
      // The tool bounds its own I/O at `readCeiling`, NOT at `maxBytes`: the
      // model-facing cap belongs to the session's after_tool policy, which
      // also owns the spill of whatever it cuts. Reading up to the ceiling is
      // what lets a body in (maxBytes, readCeiling) reach that policy whole.
      //
      // `resultBytesPreTruncation` reports the file's FULL byte length, before
      // any of this, so the ledger can answer "how much did we discard" for a
      // result that was shaped after it left here.
      const slice = await readFileSlice(target, {
        readCeiling: ctx.readCeiling ?? READ_CEILING,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const fullBytes = Bun.file(target).size;
      const { content, bounded, totalLines } = slice;
      if (offset !== undefined || limit !== undefined) {
        // A ranged read returns the requested lines and nothing else: the
        // result IS the slice, so no header leads it (the caller asked for
        // lines 3-4, and lines 3-4 are what it gets). A range that selects
        // nothing means the offset is past the last line. readTool answers that
        // with the line count rather than an empty result, because "there is
        // nothing here" is indistinguishable from "the file is empty" and the
        // model can act on the number.
        const message =
          content === ""
            ? `offset ${String(offset ?? 1)} is past the end of the file -- it has ${totalLines} lines`
            : content;
        return { content: message, resultBytesPreTruncation: fullBytes };
      }
      // Precedent from readTool's whole-file read: a leading line count, marked
      // with `+` when the read stopped at the I/O ceiling and the count is
      // therefore a floor rather than the file's true total.
      const header = `[${bounded ? `${totalLines}+` : `${totalLines}`} lines]`;
      return { content: content === "" ? header : `${header}\n${content}`, resultBytesPreTruncation: fullBytes };
    } catch (err) {
      // A missing file is a tool ERROR the model can react to, never a
      // denial -- the policy already said yes. Naming the requested path is
      // what AC7 pins: the model should see what it asked for, not "ENOENT".
      const message = err instanceof Error ? err.message : String(err);
      return { content: `cannot read "${requestedPath}": ${message}`, isError: true };
    }
  },
};

export const scratchpadListTool: CodingTool = {
  name: "ScratchpadList",
  description:
    "List files in your scratchpad at .nax/scratchpad/. Returns paths relative to the scratchpad. Reports no entries when the scratchpad is empty or has not been written to this run.",
  inputSchema: {
    type: "object",
    properties: {},
  },
  // No path field: there is nothing for the policy to gate per call. The
  // directory the tool reads is the confined directory, declared at registration.
  scope: { pathFields: [], confineTo: SCRATCHPAD_DIR },

  async run(_input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const scratchpad = join(ctx.root, SCRATCHPAD_DIR);
    // A missing scratchpad is not an error -- a model that has not written
    // anything yet (or one whose prior writes have been wiped at run start)
    // should see a clean empty listing, not an ENOENT to recover from.
    if (!existsSync(scratchpad)) return { content: "(no entries)" };

    const entries = new Bun.Glob("**/*").scanSync({ cwd: scratchpad, absolute: false, onlyFiles: true });
    // Mirror glob.ts: every match is re-checked through resolveWithin before
    // it is emitted, so a directory symlink planted inside the scratchpad
    // cannot leak external paths the policy never saw. resolveWithin runs
    // the symlink through isInside(realOrRaw(...)), so a symlink to outside
    // the policy root yields null and the entry is skipped.
    //
    // Sort first, then cap. Capping first would leak the scan's enumeration
    // order into the model, which is not what any caller expects from a
    // listing -- a deterministic alphabetical prefix is the useful signal
    // when a scratchpad has grown past the cap. scanSync materializes the
    // full list before we see it, so the sort/cap are bounded by what the
    // scan produced, not by anything the tool itself decided to walk.
    const sorted = [...entries].sort();
    const files: string[] = [];
    for (const hit of sorted) {
      if (files.length >= MAX_MATCHES) break;
      if (resolveWithin(ctx.root, hit) === null) continue;
      files.push(hit.split(sep).join("/"));
    }
    if (files.length === 0) return { content: "(no entries)" };

    const rendered = files.join("\n");
    return { content: truncate(rendered, ctx.maxBytes) };
  },
};
