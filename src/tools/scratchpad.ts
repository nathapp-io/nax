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
import { readPrefix } from "@/utils/bounded-io";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

/** The canonical scratchpad path, written into the policy as `scope.confineTo`. */
export const SCRATCHPAD_DIR = ".nax/scratchpad";

/** Truncate content to `maxBytes` with a marker, preserving the byte ceiling. */
function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  const suffix = `\n... [truncated at ${maxBytes} bytes]`;
  const suffixLen = Buffer.byteLength(suffix, "utf8");
  // Ceiling too small to fit the marker -- return a plain slice with no suffix
  // rather than exceeding maxBytes. Mirrors read.ts so the audit log sees
  // the same shape from both tools.
  if (suffixLen >= maxBytes) return Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8");
  const budget = maxBytes - suffixLen;
  return `${Buffer.from(body, "utf8").subarray(0, budget).toString("utf8")}${suffix}`;
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
    "Read a throwaway file from your scratchpad at .nax/scratchpad/. Paths are relative to the scratchpad. Use it to re-read notes, command output and intermediate lists you wrote with ScratchpadWrite.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the scratchpad directory" },
    },
    required: ["path"],
  },
  scope: { pathFields: ["path"], confineTo: SCRATCHPAD_DIR },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const requestedPath = typeof input.path === "string" ? input.path : "<path>";
    try {
      // Read up to ctx.maxBytes + 1 (readPrefix's overshoot contract): the
      // extra byte is how we tell "this is the whole thing" from "there was
      // more", without a second stat. The file's true size comes from
      // `Bun.file(target).size` so resultBytesPreTruncation is the FULL byte
      // length even when no truncation happened -- AC13 pins this for both
      // the truncated and the untruncated case.
      const file = Bun.file(target);
      const fullBytes = file.size;
      const body = await readPrefix(target, ctx.maxBytes);
      const truncated = fullBytes > ctx.maxBytes;
      const content = truncated ? truncate(body, ctx.maxBytes) : body;
      return {
        content,
        resultBytesPreTruncation: fullBytes,
      };
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
    const files = [...entries].sort();
    if (files.length === 0) return { content: "(no entries)" };

    // Render relative to the scratchpad itself (so a Write at `a/b/notes.md`
    // appears as `a/b/notes.md`, never as `.nax/scratchpad/a/b/notes.md`).
    // One line per file, repo-relative paths use `/` regardless of host OS
    // so the output is portable.
    const lines = files.map((f) => f.split(sep).join("/"));
    return { content: lines.join("\n") };
  },
};
