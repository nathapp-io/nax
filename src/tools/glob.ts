/**
 * List files matching a glob, always relative to and bounded by the root.
 *
 * Bun.Glob scans from a cwd, so the root is the cwd and results are relative by
 * construction. A pattern that tries to climb out ("../**") therefore matches
 * nothing rather than escaping.
 */

import { sep } from "node:path";
import { resolveWithin } from "./policy";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const MAX_MATCHES = 500;

/**
 * A pattern with a ".." segment can only match paths outside the root, so it
 * is answered without scanning at all: Bun.Glob would otherwise walk the
 * parent tree (unbounded on real filesystems) just to yield hits that
 * resolveWithin would discard. The result echoes no pattern, so no ".." can
 * leak into the output.
 */
function climbsOut(pattern: string): boolean {
  return pattern.split(/[\\/]/).includes("..");
}

export const globTool: CodingTool = {
  name: "Glob",
  description:
    "List repository files matching a glob pattern (e.g. 'src/**/*.ts'). Results are paths relative to the repository root.",
  inputSchema: {
    type: "object",
    properties: { pattern: { type: "string", description: "Glob pattern, relative to the repository root" } },
    required: ["pattern"],
  },
  // The pattern is not a path: it is matched inside the root by construction,
  // so there is no path field for the policy to gate. Grant-level gating still
  // applies, which is what decides whether Glob may run at all.
  scope: { pathFields: [] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== "string") return { content: "pattern must be a string", isError: true };
    if (climbsOut(pattern)) return { content: "no matches" };

    const matches: string[] = [];
    try {
      // `absolute: false` is the repo-wide idiom (test-scanner.ts:318,
      // fragments/store.ts:53, manifest-purge.ts:64) and yields root-relative
      // paths directly. Each is still re-checked through resolveWithin, because
      // a pattern that climbs out must produce nothing rather than escape.
      const glob = new Bun.Glob(pattern);
      for await (const hit of glob.scan({ cwd: ctx.root, absolute: false })) {
        if (resolveWithin(ctx.root, hit) === null) continue;
        matches.push(hit.split(sep).join("/"));
        if (matches.length >= MAX_MATCHES) break;
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    if (matches.length === 0) return { content: `no matches for "${pattern}"` };
    return { content: matches.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("\n") };
  },
};
