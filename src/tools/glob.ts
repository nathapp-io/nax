/**
 * List files matching a glob, always relative to and bounded by the root.
 *
 * Bun.Glob scans from a cwd, so the root is the cwd and results are relative by
 * construction. A pattern that tries to climb out ("../**") therefore matches
 * nothing rather than escaping.
 *
 * Output is directory-grouped — one line per parent directory, basenames
 * joined with single spaces, basenames containing whitespace or a quote
 * wrapped in double quotes and escaped (`\\`, `\"`, `\n`, `\r`, `\t`). A
 * match directly at the repository root is grouped under the prefix `./`, so
 * every line has a directory prefix and there is no second shape to
 * recognise. The format is lossless: parsing each line back into
 * `<dir>/ <b1> <b2> ...`, unescaping each quoted basename, and joining each
 * basename to its directory reconstructs the matched set exactly.
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
 * Escapes applied inside a quoted basename. Four are required to keep the
 * format lossless: `"` (would otherwise end the quoted form early), `\` (it
 * introduces the escapes, so it must escape itself), and the line terminators
 * `\n` / `\r` (group lines are joined by `\n`, so a literal one inside a
 * basename would split a single line into two). `\t` is escaped as well, so a
 * consumer that tokenises on whitespace rather than on this grammar still
 * sees one basename. Everything else passes through unchanged; this is not a
 * general-purpose escape.
 */
const ESCAPED_BASENAME_CHARS: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function escapeBasename(b: string): string {
  // The `?? c` arm is unreachable — the regex only matches the keys above —
  // but it keeps the callback's return type `string` for `String.replace`.
  return b.replace(/[\\"\n\r\t]/g, (c) => ESCAPED_BASENAME_CHARS[c] ?? c);
}

/**
 * Bucket a flat match list by parent directory and render each bucket as one
 * line: `<dir>/ <b1> <b2> ...`. The shape is identical whether the result
 * holds one match or many, so a wide listing and an existence probe read the
 * same way. A basename containing whitespace or a quote is wrapped in double
 * quotes, with the characters above escaped inside the quotes; every other
 * basename — including one that contains only a backslash — passes through
 * unchanged. Group lines and basenames are both sorted ascending, so the
 * output is deterministic for a given match set.
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
    const rendered = bucket.map((b) => (needsQuoting(b) ? `"${escapeBasename(b)}"` : b));
    // The dir prefix carries the same quoting rules a basename does: a dir
    // containing whitespace or `"` is wrapped in double quotes with the same
    // escapes, so `<dir>/ <b1> <b2> ...` stays mechanically splittable in
    // either shape and the round-trip — AC-5 — survives a directory whose
    // name contains a space (e.g. `my code/` would otherwise render as
    // `my code/ a.ts`, ambiguous on whitespace).
    const dirPrefix = needsQuoting(dir) ? `"${escapeBasename(dir)}"` : dir;
    lines.push(`${dirPrefix} ${rendered.join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * True when a basename needs quoting to keep the format unambiguous: any
 * whitespace (would split a single basename into multiple tokens), or the
 * quote character itself (would terminate the quoted form early).
 */
function needsQuoting(b: string): boolean {
  return /[\s"]/.test(b);
}

export const globTool: CodingTool = {
  name: "Glob",
  description:
    "List repository files matching a glob pattern, grouping matches by their parent directory. One line per parent directory, basenames sorted ascending, e.g. 'path/to/ a.ts b.ts'. Each line is lossless — concatenating the prefix and a basename reproduces the matched path. A basename is wrapped in double quotes when it contains whitespace or a double quote, and inside quotes the escapes \\\\, \\\", \\n, \\r and \\t stand for the literal character; outside quotes nothing is escaped, so a bare backslash is literal. The tool can also be used to check whether a path exists (call with a literal path like 'src/a.ts'; a hit returns 'src/ a.ts', a miss returns 'no matches for \"src/a.ts\"'). Patterns are matched relative to the repository root; a pattern that tries to climb out matches nothing.",
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
