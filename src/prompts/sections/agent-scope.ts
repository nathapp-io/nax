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

export function buildAgentScopeSection(root: string | undefined, workdirLabel: string | undefined): string | undefined {
  if (root === undefined || root.trim() === "") return undefined;
  // Post-single-frame-redesign the containment root is the repo/worktree root,
  // so "which package is this story in" can only come from workdirLabel (the
  // story's package-relative workdir, "." at the repo root), threaded from the
  // caller rather than derived from a root/repoRoot difference that no longer
  // exists.
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
