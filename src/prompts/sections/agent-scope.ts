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

/** The worktree segment `packageWorkdir()` bakes into an isolated story's root. */
const WORKTREE_DIR = ".nax-wt";

/**
 * The package label to show, with any worktree scratch prefix removed.
 *
 * Under `storyIsolation: "worktree"` the root is `<repo>/.nax-wt/<storyId>/<pkg>`
 * (src/worktree/manager.ts), so the naive relative path leaks the scratch
 * directory and the story id into the prompt. Both are noise to the agent, and
 * naming them invites it to reason about a path it should not care about.
 * Returns "" when the root IS the repo root.
 */
function packageLabel(root: string, repoRoot: string | undefined): string {
  const rel = repoRoot === undefined || repoRoot.trim() === "" ? root : relative(repoRoot, root);
  const segments = rel.split(/[\\/]/).filter((segment) => segment !== "");
  if (segments[0] !== WORKTREE_DIR) return segments.join("/");
  // Drop `.nax-wt` and the story id beneath it.
  return segments.slice(2).join("/");
}

export function buildAgentScopeSection(root: string | undefined, repoRoot: string | undefined): string | undefined {
  if (root === undefined || root.trim() === "") return undefined;
  const label = packageLabel(root, repoRoot);

  if (label === "") {
    return [
      "## Your file scope",
      "",
      "Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at the repository root.",
      "Every path you pass them is resolved from there, and nothing outside it can be opened.",
    ].join("\n");
  }

  return [
    "## Your file scope",
    "",
    `Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at \`${label}\`, NOT at the repository root.`,
    `Spell every path relative to that directory: write \`src/index.ts\`, never \`${label}/src/index.ts\`.`,
    "",
    `If a path you were given already starts with \`${label}/\`, strip that prefix before using it.`,
    "If it names a different package, your tools cannot open it — say so rather than guessing at its contents.",
  ].join("\n");
}
