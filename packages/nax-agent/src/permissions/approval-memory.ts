/** Shared session approval-memory policy, ported from the ACP server (nax#2553). */
export interface ApprovalMemoryRequest {
  readonly tool: string;
  readonly command?: string;
}

export type ApprovalMemoryDecision = "allow" | "deny";

/** Keep aligned with the ACP display's execute tools, without depending on that transport. */
const APPROVAL_EXECUTE_TOOLS: ReadonlySet<string> = new Set(["Bash", "RunCommand", "Git", "GitCommit"]);

/** Chaining, pipes, substitution, subshells, redirection and line breaks. */
const SHELL_METACHARACTERS = /[;&|`$()<>\n\r]/;

/** First words that run another command or arbitrary code. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "env",
  "xargs",
  "sudo",
  "doas",
  "su",
  "command",
  "builtin",
  "eval",
  "exec",
  "source",
  ".",
  "nohup",
  "time",
  "timeout",
  "nice",
  "ionice",
  "stdbuf",
  "watch",
  "find",
  "node",
  "bun",
  "deno",
  "npx",
  "bunx",
  "pnpx",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "uv",
  "uvx",
]);

/** A plain command name or path: no quotes, escapes, globs or expansions the shell would rewrite. */
const PLAIN_WORD = /^[A-Za-z0-9._/-]+$/;

/** The masking prefix S3 puts in place of a secret in a shown command. */
const MASK_MARKER = "[REDACTED";

/**
 * Tool key, or execute tool plus command/subcommand. Unsafe, masked, wrapper and
 * flag-second-word requests have no key. A key alone never authorizes a command:
 * callers must also check approvalMemoryApplies against the remembered decision.
 */
export function approvalMemoryKey(request: ApprovalMemoryRequest): string | undefined {
  if (!APPROVAL_EXECUTE_TOOLS.has(request.tool)) return request.tool;
  const command = request.command ?? "";
  if (command.includes(MASK_MARKER)) return undefined;
  const [first = "", second] = command.trim().split(/\s+/);
  if (!PLAIN_WORD.test(first)) return undefined;
  const name = first.slice(first.lastIndexOf("/") + 1).toLowerCase();
  if (name === "" || WRAPPERS.has(name)) return undefined;
  if (second === undefined) return `${request.tool}:${first}`;
  // A flag can change what the command does (`rm -f`, `git -C repo`): remembering the bare command would
  // approve every later invocation of it, so a flag second word is never remembered (nax#2553).
  if (second.startsWith("-")) return undefined;
  return PLAIN_WORD.test(second) ? `${request.tool}:${first} ${second}` : undefined;
}

/**
 * Whether a decision found under this request's key may answer without asking.
 * Allows cover only simple commands with plain, non-flag words after the key;
 * denies cover their matching key regardless. Does not validate key eligibility.
 */
export function approvalMemoryApplies(request: ApprovalMemoryRequest, decision: ApprovalMemoryDecision): boolean {
  if (decision === "deny" || !APPROVAL_EXECUTE_TOOLS.has(request.tool)) return true;
  const command = request.command ?? "";
  if (SHELL_METACHARACTERS.test(command)) return false;
  const rest = command.trim().split(/\s+/).slice(2);
  return rest.every((word) => PLAIN_WORD.test(word) && !word.startsWith("-"));
}
