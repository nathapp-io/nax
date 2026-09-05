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

export function buildGrepArgv(binary: "rg" | "grep", pattern: string, path: string | undefined): string[] {
  const target = path ?? ".";
  // `--` terminates flag parsing: a pattern beginning with "-" is then data,
  // not an option. Neither binary is ever handed a shell string.
  if (binary === "rg") {
    return ["rg", "--fixed-strings", "--line-number", "--no-heading", "--color", "never", "--", pattern, target];
  }
  return ["grep", "-r", "-n", "-F", "--", pattern, target];
}

function truncate(body: string, maxBytes: number): string {
  if (Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  return `${Buffer.from(body, "utf8").subarray(0, maxBytes).toString("utf8")}\n... [truncated at ${maxBytes} bytes]`;
}

export const grepTool: CodingTool = {
  name: "Grep",
  description:
    "Search repository file contents for a literal string. Returns 'path:line:text' rows relative to the repository root when no subdirectory target is supplied, absolute when one is (rg prints the target as given).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Literal string to search for" },
      path: { type: "string", description: "Optional subdirectory, relative to the repository root" },
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

    const binary: "rg" | "grep" | null = _grepDeps.which("rg") ? "rg" : _grepDeps.which("grep") ? "grep" : null;
    if (binary === null) {
      return { content: "neither ripgrep nor grep is available on this machine", isError: true };
    }

    const [target] = ctx.resolvedPaths;
    const proc = _grepDeps.spawn(buildGrepArgv(binary, pattern, target), {
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
    // Both binaries exit 1 for "no matches" — a normal outcome, not a failure.
    if (exitCode === 1 && stdout.trim() === "") {
      const base = `no matches for "${pattern}"`;
      // Disclose that the search was literal when the pattern contained regex metacharacters,
      // so callers know their pattern was not interpreted as a regex.
      if (containsRegexMetacharacter(pattern)) {
        return {
          content: `${base}. The search was performed literally and regex metacharacters were not interpreted.`,
        };
      }
      return { content: base };
    }
    if (exitCode !== 0 && stdout.trim() === "") {
      return { content: (await stderrText).trim() || `${binary} exited ${exitCode}`, isError: true };
    }
    return { content: truncate(stdout.trimEnd(), ctx.maxBytes) };
  },
};
