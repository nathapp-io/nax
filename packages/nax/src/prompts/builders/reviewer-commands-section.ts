/**
 * nax#2500: reviewers may run commands to verify; the tree is restored after each turn.
 * nax#2904: when the project configures verification commands, list them verbatim so a
 * reviewer runs what the gates run instead of guessing a runner.
 */
import type { PromptSection } from "../core/types";

/** One configured command as the reviewer sees it (shape of operations' ReviewerCommandLine). */
export interface ReviewerCommandEntry {
  readonly name: string;
  readonly steps: readonly string[];
  /** Repo-relative directory; "." is the repo root. */
  readonly dir: string;
}

const CONTENT = [
  "## Verifying with commands",
  "",
  "If a shell tool is available, you may run commands to verify what you review: formatters and linters",
  "in check mode (for example `--check` or `--diff`), a linter on one file, a scoped test run, and",
  "read-only git (`git diff`, `git log`, `git show`, `git blame`). Commands run inside a sandbox.",
  "Do not edit files or git state. Changes to tracked and non-ignored files, the index and your branch",
  "are reverted after your turn, and the revert is logged.",
].join("\n");

const FILES_NOTE =
  "`{{files}}` stands for the test files you choose, space-separated, as paths relative to that directory.";
const PACKAGE_NOTE = "`{{package}}` stands for the story package's name from its manifest.";

/** Inline code that survives a backtick inside the command (CommonMark: a longer fence, padded). */
function code(text: string): string {
  if (!text.includes("`")) return `\`${text}\``;
  const longest = Math.max(...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
}

function commandLine(entry: ReviewerCommandEntry): string {
  const where = entry.dir === "." ? "run from the repo root" : `run from ${code(entry.dir)}`;
  return `- \`${entry.name}\` (${where}): ${entry.steps.map(code).join(", then ")}`;
}

function projectCommandsBlock(commands: readonly ReviewerCommandEntry[]): string {
  const steps = commands.flatMap((entry) => entry.steps);
  const notes = [
    ...(steps.some((step) => step.includes("{{files}}")) ? [FILES_NOTE] : []),
    ...(steps.some((step) => step.includes("{{package}}")) ? [PACKAGE_NOTE] : []),
  ];
  return [
    "### Project commands",
    "",
    "These are the commands this project configures for nax's gates, with the directory each runs from.",
    "They are known to work here; use them or adapt them as you need.",
    "",
    ...commands.map(commandLine),
    ...(notes.length > 0 ? ["", ...notes] : []),
  ].join("\n");
}

export function reviewerCommandsSection(commands: readonly ReviewerCommandEntry[] = []): PromptSection {
  const content = commands.length === 0 ? CONTENT : `${CONTENT}\n\n${projectCommandsBlock(commands)}`;
  return { id: "reviewer-commands", content, overridable: false };
}
