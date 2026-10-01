/**
 * Repo-root discovery for scripts and tests that read repo-wide resources
 * (.nax/rules, .claude/rules, .github/workflows, docs/). After the monorepo
 * move, a package's own root (`import.meta.dir/..`) is no longer the git root.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`findRepoRoot: no .git found above ${start}`);
    dir = parent;
  }
}
