import type { SelfVerificationPromptInput } from "@/quality/self-verification";

const CHECK_HEADER = "# Self-Verification Gate";

/**
 * Offer the declared key first, then the shell string -- both, because this one
 * prompt is read on two transports with different tools.
 *
 * Rendering only the shell string is what produced the defect the Exec
 * allowlist was built for: a native model told to "run `bun x tsc --noEmit`"
 * runs that literal string, and nothing native takes it -- `RunCommand`
 * resolves declared keys and the argv branch admits install forms only. It
 * reached for the argv branch, was denied, and abandoned the fix.
 *
 * Rendering only the key is the mirror-image bug, and on the more-travelled
 * path: `RunCommand` is a nax-hosted coding tool wired solely into the native
 * turn loop (`agents/native/session/turn-loop.ts`), and `agents/acp/` never
 * receives `codingTools` at all. An ACP agent has a shell and the shell string
 * is its only affordance -- so deleting it would strand the default transport
 * (`resolveDefaultAgent` -> "claude" -> `AcpAgentAdapter`).
 *
 * Naming both, key first, is transport-neutral: each model takes the branch it
 * has, and neither is instructed toward a tool it was never advertised. The
 * protocol is not known here in any case -- it is resolved after this prompt is
 * joined, and a fallback swap can change it afterwards (see the note in
 * `prompts/sections/diff-access.ts`).
 *
 * `label` IS the key: both sides read `quality.commands.<label>`, so the string
 * rendered is exactly what `RunCommand` accepts in `command`.
 */
function commandLine(label: "lint" | "typecheck", command: string | undefined): string {
  if (!command) return `- ${label}: unconfigured -> report \`skip\``;
  return `- ${label}: run the project's declared \`${label}\` check -- RunCommand {"command": "${label}"} if that tool is available to you, otherwise \`${command}\``;
}

function roleSpecificLine(role: string): string {
  if (role === "no-test") {
    return "- Keep the no-test contract: do not create or modify behavioral tests in this step.";
  }
  return "- Use this gate before you declare your turn complete.";
}

export function buildSelfVerificationSection(role: string, input: SelfVerificationPromptInput | undefined): string {
  if (!input) return "";

  const lines = [
    CHECK_HEADER,
    "",
    "Before you finish, run static checks for your own changes in this package.",
    `- packageDir: \`${input.packageDir}\``,
    input.language ? `- language: \`${input.language}\`` : "- language: unknown",
    roleSpecificLine(role),
    "- Scope: focus first on changed files from this turn (`CHANGED`) inside this package.",
    commandLine("lint", input.lintCommand),
    commandLine("typecheck", input.typecheckCommand),
    "- If a configured check fails on files in CHANGED: fix and rerun.",
    "- If a configured check fails outside CHANGED but the smallest package-local fix is required to satisfy this story's acceptance criteria, you MAY make that fix and rerun.",
    "- Otherwise, do not edit unrelated sibling files; report them under PRE_EXISTING_FAILURES.",
    "",
    "End your response with exactly this block:",
    "```text",
    "SELF_VERIFICATION:",
    "lint: pass|skip|pre_existing|fail",
    "typecheck: pass|skip|pre_existing|fail",
    "PRE_EXISTING_FAILURES: []",
    "```",
  ];

  return lines.join("\n");
}
