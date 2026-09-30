// tools/monorepo/lib/constants.ts
export const PKG_DIR = "packages/nax";

/** Tracked top-level entries that stay at the repo root (spec §3). Everything else moves. */
export const KEEP_AT_ROOT: ReadonlySet<string> = new Set([
  ".github", ".gitignore", ".git-blame-ignore-revs", ".semgrepignore",
  "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "LICENSE",
  "docs", ".nax", ".claude", "CLAUDE.md", "AGENTS.md", "GEMINI.md", "codex.md",
  "bun.lock", "tools",
]);

/** Kept at root AND copied into the package (npm tarball needs it). */
export const COPY_TO_PKG: readonly string[] = ["LICENSE"];

/** Root .gitignore entries anchored under moved dirs (spec §3.3). */
export const GITIGNORE_MOVE: readonly string[] = ["test/tmp/", "test/integration/tmp/", "tmp/.ci-test-output.txt"];

/** First path segments that move into the package; an anchored ignore entry under one of these must be in GITIGNORE_MOVE. */
export const MOVED_TOP_DIRS: ReadonlySet<string> = new Set([
  "src", "bin", "test", "scripts", "stubs", "examples", "biome-plugins", ".reports", "tmp",
]);
