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
 * context, bypassing the model-facing ceiling the after_tool policy
 * applies to every other content-returning tool.
 */
const MAX_MATCHES = 500;

export const scratchpadWriteTool: CodingTool = {
  name: "ScratchpadWrite",
  description:
    "Write a throwaway file to your scratchpad at .nax/scratchpad/. Use it for notes to yourself, command output you want to re-read, intermediate lists, or a probe script to run against the project's code. It is never committed and is wiped when a run finishes (a failed run's scratchpad is retained for inspection until the next run starts and clears it). Paths are relative to the scratchpad and cannot reach the repository.",
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
      // The header leads EVERY read that returns file content, the paged one
      // included: it reports the FILE's line count, which is what a model
      // paging a spilled body needs in order to know how many pages remain —
      // the page it asked for is not a substitute for that number. Precedent
      // from readTool's whole-file read, marked with `+` when the read stopped
      // at the I/O ceiling and the count is therefore a floor rather than the
      // file's true total.
      const header = `[${bounded ? `${totalLines}+` : `${totalLines}`} lines]`;
      if (offset !== undefined || limit !== undefined) {
        // An offset past the last line is answered with the line count rather
        // than an empty result, because "there is nothing here" is
        // indistinguishable from "the file is empty" and the model can act on
        // the number -- and there the count IS the message, so no header leads
        // it. The condition is the OFFSET against the file, never the emptiness
        // of the slice: a range that selects only blank lines is a perfectly
        // valid page, and reporting it as past-the-end would hide content the
        // caller asked for and that the file really holds.
        if (offset !== undefined && offset > totalLines) {
          const pastEnd = `offset ${String(offset)} is past the end of the file -- it has ${totalLines} lines`;
          return { content: pastEnd, resultBytesPreTruncation: fullBytes };
        }
        // The header goes on its own line and the requested range follows it,
        // verbatim -- possibly empty, when the page holds blank lines.
        // readTool's ranged read composes it the same way.
        return { content: `${header}\n${content}`, resultBytesPreTruncation: fullBytes };
      }
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
    return { content: rendered };
  },
};
