/**
 * The scope block: which tree the agent's file tools are rooted at, and how to
 * spell a path for them.
 *
 * Nothing else in any prompt says this. The agent's tools are contained at a
 * root it is never told about, so it cannot tell "outside my reach" from "does
 * not exist" -- it discovers the boundary only by failing, and the refusal is
 * deliberately terse. That gap produces wrong conclusions, not just friction:
 * a reviewer shown a file it cannot open reports the file as missing.
 *
 * Pure and protocol-agnostic: the dispatch seam prepends it for both arms.
 */

import { relative } from "node:path";

/** The reserved worktree segment an isolated story's root is nested under. */
const WORKTREE_DIR = ".nax-wt";

/**
 * The package label to show, with any worktree scratch prefix removed.
 *
 * Post-nax#2093 the sole producer (`src/agents/tool-preamble.ts`) passes the
 * story's worktree root as `repoRoot` and its package workdir as `root`, so
 * `relative(repoRoot, root)` is already the bare package path (`packages/api`)
 * and the strip below no longer fires in production.
 *
 * Retained as defence-in-depth: it is pure, the pair it handles is exactly what
 * a regression that re-pointed `repoRoot` back at the main checkout would
 * produce, and the naive relative path would then leak the scratch directory and
 * the story id into the prompt — noise that invites the agent to reason about a
 * path it should not care about. Returns "" when the root IS the repo root.
 */
function packageLabel(root: string, repoRoot: string | undefined): string {
  const rel = repoRoot === undefined || repoRoot.trim() === "" ? root : relative(repoRoot, root);
  const segments = rel.split(/[\\/]/).filter((segment) => segment !== "");
  if (segments[0] !== WORKTREE_DIR) return segments.join("/");
  // Drop `.nax-wt` and the story id beneath it. Unreachable from the current
  // producer — see the docblock above.
  return segments.slice(2).join("/");
}

export function buildAgentScopeSection(
  root: string | undefined,
  repoRoot: string | undefined,
  workdirLabel: string | undefined,
): string | undefined {
  if (root === undefined || root.trim() === "") return undefined;
  // Post-single-frame-redesign, root and repoRoot are always equal —
  // packageLabel(root, repoRoot) always returns "". workdirLabel (the
  // story's package-relative workdir, "." at the repo root) is the new
  // source of "which package is this story in", threaded from the
  // caller rather than derived from a root/repoRoot difference that no
  // longer exists. See packageLabel's docblock for why it stays wired
  // rather than deleted (PR 4 retires it alongside codingToolRepoRoot).
  const label = packageLabel(root, repoRoot);
  void label; // retained call for PR 4's single-unit deletion; not rendered

  const isRepoRootStory = workdirLabel === undefined || workdirLabel === "." || workdirLabel.trim() === "";

  if (isRepoRootStory) {
    return [
      "## Your file scope",
      "",
      "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root.",
      "Every path you pass them is resolved from there.",
    ].join("\n");
  }

  return [
    "## Your file scope",
    "",
    "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root, NOT at your package.",
    `Your story's package is \`${workdirLabel}\`. Spell every path repo-rooted from the repository root: write`,
    `\`${workdirLabel}/src/index.ts\`, never \`src/index.ts\`.`,
    "",
    `Declared commands (via RunCommand) still run inside \`${workdirLabel}\` — only the file tools' path frame changed.`,
    "You can read and, per your write authorization, edit files outside your package if a task genuinely requires it — say so rather than guessing at another package's contents from its name alone.",
  ].join("\n");
}
