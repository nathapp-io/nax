import type { SelfVerificationPromptInput } from "@/quality/self-verification";
import { wrapAffordance } from "./protocol-region";

const CHECK_HEADER = "# Self-Verification Gate";

/**
 * Render a configured static-check line through the protocol-region registry.
 *
 * `command` is the configured shell string (`quality.commands.<label>`). The
 * declared key the registry's `RunCommand` resolves is the `label` itself —
 * both sides read `quality.commands.<label>`, so the spec the registry
 * receives in `{"command": "<label>"}` is exactly what `RunCommand` accepts.
 *
 * US-003 — the renderer picks the transport-appropriate form at dispatch:
 *   - native + `RunCommand` advertised → a `RunCommand {"command": "<label>"}`
 *     call (no shell string, no hedge)
 *   - native without `RunCommand` → the shell string the agent CAN run
 *   - acp → the shell string (ACP has a shell, no coding tools)
 *
 * An unconfigured check (`command === undefined`) keeps the existing
 * "unconfigured" line and emits no region — there is nothing to dispatch
 * between.
 */
function commandLine(label: "lint" | "typecheck", command: string | undefined): string {
  if (!command) return `- ${label}: unconfigured -> report \`skip\``;
  const acpBody = `- ${label}: run the project's declared \`${label}\` check: \`${command}\``;
  return wrapAffordance("run-check", { command: label }, acpBody);
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
