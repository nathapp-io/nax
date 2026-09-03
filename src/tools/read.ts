/**
 * Read one file, already resolved and approved by the policy.
 *
 * The tool never resolves a path itself: it uses ctx.resolvedPaths, which the
 * policy produced. That is what keeps containment in one seam.
 */

import { readPrefix } from "@/utils/bounded-io";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const readTool: CodingTool = {
  name: "Read",
  description: "Read a UTF-8 text file from the repository. Paths are relative to the repository root.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the repository root" } },
    required: ["path"],
  },
  scope: { pathFields: ["path"] },

  async run(_input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const [target] = ctx.resolvedPaths;
    if (target === undefined) return { content: "no path supplied", isError: true };
    try {
      // A prefix, not the file: the result is truncated to the same ceiling
      // either way, so reading beyond it was only ever wasted memory.
      return { content: truncate(await readPrefix(target, ctx.maxBytes), ctx.maxBytes) };
    } catch (err) {
      // An unreadable file is a tool ERROR the model can react to, never a
      // denial: the policy already said yes.
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }
  },
};
