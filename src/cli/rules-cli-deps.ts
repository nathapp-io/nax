/**
 * `_rulesCLIDeps` — injectable deps for the `nax rules` CLI commands.
 *
 * Extracted from `src/cli/rules.ts` to its own module so that
 * `src/cli/rules-migrate.ts` can consume it without importing `rules.ts`
 * (and closing the mutual `rules.ts <-> rules-migrate.ts` import cycle).
 * See `docs/plans/STATUS-import-cycles-drain.md` Task 3.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadCanonicalRules } from "../context/rules/canonical-loader";
import { getLogger } from "../logger";
import type { GlobMatchResult } from "./rules-lint";
import { _rulesLintDeps } from "./rules-lint";

export const _rulesCLIDeps = {
  readFile: async (path: string): Promise<string> => Bun.file(path).text(),
  writeFile: async (path: string, content: string): Promise<void> => {
    await Bun.write(path, content);
  },
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
  globInDir: (dir: string): string[] => {
    try {
      return [...new Bun.Glob("*.md").scanSync({ cwd: dir })].sort().map((f) => join(dir, f));
    } catch {
      return [];
    }
  },
  mkdir: async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true });
  },
  // Delegate lazily (not a value-copy) so overriding _rulesLintDeps.* is
  // observed here too — a plain field copy at module-eval time would silently
  // diverge from whatever `nax rules lint` actually runs.
  globCanonicalRuleFiles: (workdir: string): string[] => _rulesLintDeps.globCanonicalRuleFiles(workdir),
  globHasMatch: (pattern: string, cwd: string): GlobMatchResult => _rulesLintDeps.globHasMatch(pattern, cwd),
  loadCanonicalRules,
  getLogger,
  // US-002: forward the workspace resolver so the `nax rules lint` entry
  // point keeps the same injectable seam as the inner implementation.
  discoverWorkspacePackages: (workdir: string): Promise<string[]> => _rulesLintDeps.discoverWorkspacePackages(workdir),
};
