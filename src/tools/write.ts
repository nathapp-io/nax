/**
 * Write a file whose path the policy already resolved and approved.
 *
 * No production op declares this tool: everything that writes also needs to run
 * tests, which needs Bash, which C1 excludes. It exists so #374's gate has a
 * concrete subject (design section 3.5) and is exercised by tests alone.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

export const writeTool: CodingTool = {
  name: "Write",
  description: "Write UTF-8 text to a repository file, creating it and any missing parent directories.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the repository root" },
      content: { type: "string", description: "Full file contents to write" },
    },
    required: ["path", "content"],
  },
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    const content = input.content;
    if (typeof content !== "string") return { content: "content must be a string", isError: true };

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { content: `wrote ${Buffer.byteLength(content, "utf8")} bytes` };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
