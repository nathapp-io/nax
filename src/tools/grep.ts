/**
 * Search file contents, preferring ripgrep and falling back to grep.
 *
 * Both branches spawn a subprocess, so this tool is NOT evidence that the
 * default tool set is in-process — it is not. What makes it safe is the same
 * property that makes Git safe: a fixed binary, an argv nax constructs
 * entirely, and no shell, so the model supplies data and never a command.
 *
 * The two binaries take different flags, so the argv builder is per-binary
 * rather than shared, and the fallback is tested explicitly: a machine without
 * ripgrep must produce the same matches, not a silent empty result.
 */

import { drainBounded } from "@/utils/bounded-io";
import { spawn, which } from "@/utils/bun-deps";
import type { CodingTool, ToolResult, ToolRunContext } from "./registry";

const GREP_TIMEOUT_MS = 15_000;

/** @internal */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/;

/**
 * Returns true when the pattern contains at least one regex metacharacter.
 * Used to disclose to callers that their search was performed literally.
 * @internal
 */
function containsRegexMetacharacter(pattern: string): boolean {
  return REGEX_METACHARACTERS.test(pattern);
}

/** @internal Injectable for tests — exercises the fallback without uninstalling ripgrep. */
export const _grepDeps = { which, spawn };

export type GrepPatternType = "literal" | "regex";

export function buildGrepArgv(
  binary: "rg" | "grep",
  pattern: string,
  path: string | undefined,
  patternType: GrepPatternType = "literal",
): string[] {
  const target = path ?? ".";
  // `--` terminates flag parsing on both branches, in both modes: a pattern
  // beginning with "-" is then data, not an option. Neither binary is ever
  // handed a shell string.
  if (binary === "rg") {
    // rg's own default IS regex (its "fixed-strings" flag is what disables
    // it), so the regex branch simply omits the flag rather than adding one.
    const flags =
      patternType === "literal"
        ? ["--fixed-strings", "--line-number", "--no-heading", "--color", "never"]
        : ["--line-number", "--no-heading", "--color", "never"];
    return ["rg", ...flags, "--", pattern, target];
  }
  // grep has no "regex" default to fall back to: -F is fixed-strings, and the
  // nearest equivalent to rg's regex syntax is -E (POSIX ERE, e.g. `a+`, `a|b`
  // with no backslash), not grep's default BRE.
  const modeFlag = patternType === "literal" ? "-F" : "-E";
  return ["grep", "-r", "-n", modeFlag, "--", pattern, target];
}

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const grepTool: CodingTool = {
  name: "Grep",
  description:
    "Search repository file contents for a literal string or a regular expression. Returns 'path:line:text' rows relative to the repository root when no subdirectory target is supplied, absolute when one is (rg prints the target as given). Defaults to a literal (fixed-string) search; set pattern_type to \"regex\" to interpret the pattern as a regular expression (ripgrep syntax, e.g. `foo|bar`, `\\d+`; on a machine without ripgrep the pattern falls back to POSIX ERE, which the result discloses).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description:
          'String to search for. Interpreted literally unless pattern_type is "regex", in which case it is a regular expression.',
      },
      path: { type: "string", description: "Optional subdirectory, relative to the repository root" },
      pattern_type: {
        type: "string",
        enum: ["literal", "regex"],
        default: "literal",
        description: '"literal" (default) matches pattern as a fixed string; "regex" interprets it as a regex.',
      },
    },
    required: ["pattern"],
  },
  // The optional `path` is path-bearing and is gated exactly like Read's: the
  // policy resolves it through resolveWithin, denying escapes as breaches.
  // `pattern` is not a path and needs no path gating.
  scope: { pathFields: ["path"] },

  async run(input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult> {
    const pattern = input.pattern;
    if (typeof pattern !== "string") return { content: "pattern must be a string", isError: true };

    const patternType = input.pattern_type;
    if (patternType !== undefined && patternType !== "literal" && patternType !== "regex") {
      return { content: 'pattern_type must be "literal" or "regex"', isError: true };
    }
    const mode: GrepPatternType = patternType === "regex" ? "regex" : "literal";

    const binary: "rg" | "grep" | null = _grepDeps.which("rg") ? "rg" : _grepDeps.which("grep") ? "grep" : null;
    if (binary === null) {
      return { content: "neither ripgrep nor grep is available on this machine", isError: true };
    }

    const [target] = ctx.resolvedPaths;
    const proc = _grepDeps.spawn(buildGrepArgv(binary, pattern, target, mode), {
      cwd: ctx.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, GREP_TIMEOUT_MS);

    // Drain concurrently: a large result set fills the pipe buffer and would
    // otherwise block the process before it can exit. Bounded, because the
    // result is truncated to the same ceiling anyway -- a search matching a
    // generated file could otherwise buffer far more than is ever returned,
    // limited only by how much the binary emits before the timeout fires.
    const stdoutText = drainBounded(proc.stdout, ctx.maxBytes).catch(() => "");
    const stderrText = drainBounded(proc.stderr, ctx.maxBytes).catch(() => "");
    const exitCode = await proc.exited;
    clearTimeout(timer);

    const stdout = await stdoutText;
    // Two independent caveats, either of which means the search the caller
    // asked for is not quite the search that ran.
    //
    // 1. The literal disclosure fires whenever the search was literal AND the
    //    pattern contained a metacharacter a regex would have treated
    //    specially -- regardless of whether it matched. #1876 only covered the
    //    zero-match case; a literal match on a pattern like "foo.bar" is the
    //    WORSE case (#1922): the caller has positive evidence and no cue that
    //    "." was never a wildcard, so a real regex match was never attempted.
    //
    // 2. The dialect note fires when regex mode ran through the grep fallback.
    //    ripgrep's Rust regex and POSIX ERE are NOT the same language: `\d`,
    //    `\w` and `\b` are unsupported in ERE, and whether they degrade to a
    //    literal or to something else differs BY PLATFORM (GNU grep treats
    //    `\d` as `d`; the BSD grep on macOS matches a digit). Silently
    //    returning a different answer depending on which binary the machine
    //    happens to have is exactly the failure this file's header forbids of
    //    the fallback, so the divergence is disclosed rather than hidden.
    const notes: string[] = [];
    if (mode === "literal" && containsRegexMetacharacter(pattern)) {
      notes.push("The search was performed literally and regex metacharacters were not interpreted.");
    }
    if (mode === "regex" && binary === "grep") {
      notes.push(
        "ripgrep is not installed here, so the pattern was matched with POSIX ERE via grep: escapes such as \\d, \\w and \\b are NOT supported — use [0-9], [A-Za-z0-9_] and similar instead.",
      );
    }
    const caveat = notes.join(" ");

    // Both binaries exit 1 for "no matches" — a normal outcome, not a failure.
    if (exitCode === 1 && stdout.trim() === "") {
      const base = `no matches for "${pattern}"`;
      return { content: caveat === "" ? base : `${base}. ${caveat}` };
    }
    if (exitCode !== 0 && stdout.trim() === "") {
      return { content: (await stderrText).trim() || `${binary} exited ${exitCode}`, isError: true };
    }
    // The caveat leads rather than trails, and truncation is applied to the
    // whole body: appended after truncate() it both overran ctx.maxBytes and was
    // the first thing lost on a result large enough to need the cue most.
    const matches = stdout.trimEnd();
    const body = caveat === "" ? matches : `${caveat}\n\n${matches}`;
    return { content: truncate(body, ctx.maxBytes) };
  },
};
