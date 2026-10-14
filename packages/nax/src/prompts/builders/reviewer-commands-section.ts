/** nax#2500: reviewers may run commands to verify; the tree is restored after each turn. */
import type { PromptSection } from "../core/types";

const CONTENT = [
  "## Verifying with commands",
  "",
  "If a shell tool is available, you may run commands to verify what you review: formatters and linters",
  "in check mode (for example `--check` or `--diff`), a linter on one file, a scoped test run, and",
  "read-only git (`git diff`, `git log`, `git show`, `git blame`). Commands run inside a sandbox.",
  "Do not edit files or git state. Changes to tracked and non-ignored files, the index and your branch",
  "are reverted after your turn, and the revert is logged.",
].join("\n");

export function reviewerCommandsSection(): PromptSection {
  return { id: "reviewer-commands", content: CONTENT, overridable: false };
}
