/**
 * List files matching a glob, always relative to and bounded by the root.
 *
 * Bun.Glob scans from a cwd, so the root is the cwd and results are relative by
 * construction. A pattern that tries to climb out ("../**") therefore matches
 * nothing rather than escaping.
 *
 * Output is directory-grouped — one line per parent directory, basenames
 * joined with single spaces, basenames containing whitespace wrapped in
 * double quotes. A match directly at the repository root is grouped under
 * the prefix `./`, so every line has a directory prefix and there is no
 * second shape to recognise. The format is lossless: parsing each line back
 * into `<dir>/ <b1> <b2> ...` and joining each basename to its directory
 * reconstructs the matched set exactly.
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

/**
 * @internal Injectable for tests — exercises the catch path without planting
 * a malformed pattern on disk. Production wires this to `Bun.Glob`'s async
 * `scan({ cwd, absolute })` iterator.
 */
export const _globDeps = {
  scan(pattern: string, opts: { cwd: string; absolute: boolean }): AsyncIterable<string> {
    return new Bun.Glob(pattern).scan(opts);
  },
};

/**
 * Bucket a flat match list by parent directory and render each bucket as one
 * line: `<dir>/ <b1> <b2> ...`. The shape is identical whether the result
 * holds one match or many, so a wide listing and an existence probe read the
 * same way. Whitespace in a basename is quoted; everything else passes
 * through unchanged. Group lines and basenames are both sorted ascending, so
 * the output is deterministic for a given match set.
 */
function renderGrouped(matches: readonly string[]): string {
  const byDir = new Map<string, string[]>();
  for (const path of matches) {
    const lastSlash = path.lastIndexOf("/");
    const dir = lastSlash === -1 ? "./" : `${path.slice(0, lastSlash + 1)}`;
    const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
    let bucket = byDir.get(dir);
    if (bucket === undefined) {
      bucket = [];
      byDir.set(dir, bucket);
    }
    bucket.push(basename);
  }
  const dirs = [...byDir.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const lines: string[] = [];
  for (const dir of dirs) {
    const bucket = byDir.get(dir) ?? [];
    bucket.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const rendered = bucket.map((b) => (/\s/.test(b) ? `"${b}"` : b));
    lines.push(`${dir} ${rendered.join(" ")}`);
  }
  return lines.join("\n");
}

export const globTool: CodingTool = {
  name: "Glob",
  description:
    "List repository files matching a glob pattern, grouping matches by their parent directory. One line per parent directory, basenames sorted ascending, e.g. 'path/to/ a.ts b.ts'. Each line is lossless — concatenating the prefix and a basename reproduces the matched path. The tool can also be used to check whether a path exists (call with a literal path like 'src/a.ts'; a hit returns 'src/ a.ts', a miss returns 'no matches for \"src/a.ts\"'). Patterns are matched relative to the repository root; a pattern that tries to climb out matches nothing.",
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
      // The scan itself goes through `_globDeps.scan` so a test can substitute
      // a throwing iterator and exercise the catch branch without planting a
      // malformed pattern on disk.
      for await (const hit of _globDeps.scan(pattern, { cwd: ctx.root, absolute: false })) {
        if (resolveWithin(ctx.root, hit) === null) continue;
        matches.push(hit.split(sep).join("/"));
        if (matches.length >= MAX_MATCHES) break;
      }
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    if (matches.length === 0) return { content: `no matches for "${pattern}"` };
    return { content: renderGrouped(matches) };
  },
};
