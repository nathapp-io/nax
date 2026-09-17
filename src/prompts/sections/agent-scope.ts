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

  const lines = [
    "## Your file scope",
    "",
    `Your file tools (Read, Write, Edit, Glob, Grep, Git) are rooted at \`${label}\`, NOT at the repository root.`,
    `Spell every path relative to that directory: write \`src/index.ts\`, never \`${label}/src/index.ts\`.`,
    "",
  ];
  // Only a multi-segment label is safe to strip. A single-segment label (`api`)
  // is indistinguishable from the first segment of a package-relative path, so
  // the old unconditional rule deleted real prefixes: label `api`, path
  // `api/openapi.yaml`, rewritten to `openapi.yaml` and not found. Prompt-
  // embedded git output is package-relative as of nax#2101, so this now covers
  // only repo-root-relative paths named elsewhere in the prompt.
  if (label.includes("/")) {
    lines.push(
      `If a path you were given starts with \`${label}/\`, it is relative to the repository root — drop that prefix and use the rest.`,
    );
  }
  lines.push(
    "If it names a different package, your tools cannot open it — say so rather than guessing at its contents.",
  );
  return lines.join("\n");
}
