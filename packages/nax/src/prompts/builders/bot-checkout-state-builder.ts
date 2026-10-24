export interface CheckoutStateInput {
  phase: "fresh" | "after-fix";
  headSha: string;
  setup: readonly string[];
  setupFailed?: string;
  ciFiles: readonly string[];
  pinnedBase?: boolean;
}

export const PINNED_BASE_NOTE =
  "Agent configuration (CLAUDE.md, AGENTS.md and the other instruction files, .claude/, .mcp.json and each agent's config directory) holds the base branch's versions for this session; nax restores the PR's versions afterwards. Do not edit, stage or commit those files.";

const SHORT_SHA_LENGTH = 7;

/** Pure checkout/setup context shared by bot review, fix and repair prompts. */
export function renderCheckoutState(input: CheckoutStateInput): string {
  const sha = input.headSha.slice(0, SHORT_SHA_LENGTH);
  const checkout =
    input.phase === "fresh"
      ? `This is a fresh git worktree of the PR head ${sha}: tracked files plus the setup below.`
      : `This git worktree holds the fix commit on top of the PR head ${sha}, plus the setup below.`;
  const status = input.setupFailed ? `failed at ${input.setupFailed}` : "all succeeded";
  const setup = input.setup.length ? `${input.setup.join(", ")} — ${status}` : "none";
  return [
    checkout,
    `Setup nax ran: ${setup}`,
    `CI config files: ${input.ciFiles.length ? input.ciFiles.join(", ") : "none found"}`,
    "Git-ignored outputs (generated code, build output, caches) may be missing. If a check fails for missing setup, run the setup steps CI runs (see the CI config files); changes to git-ignored files are kept and are not part of your commit.",
    ...(input.pinnedBase ? [PINNED_BASE_NOTE] : []),
  ].join("\n");
}
