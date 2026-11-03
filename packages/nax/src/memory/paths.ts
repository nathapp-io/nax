/**
 * Memory mirror directories.
 *
 * A memory mirror lives under the global nax directory, not the repository:
 * `~/.nax/memory/projects/<segment>-<hash8>` per project and `~/.nax/memory/user`
 * once for the machine. The hash is deliberately taken over the *canonical*
 * repository root (`realpath`), so a symlinked checkout shares the mirror of the
 * repository it points at, and two repositories that happen to share a basename
 * never share one.
 *
 * `globalConfigDir()` is the only supported way to reach `~/.nax`
 * (`check:no-real-global-nax`), so this module resolves the global directory
 * through it rather than joining `homedir()`.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getProjectKey, globalConfigDir, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import type { Logger } from "@/logger";

/** Directory under the global config dir that holds every memory mirror. */
const MEMORY_DIR_NAME = "memory";
/** Per-project mirrors live here, one directory per repository. */
const MEMORY_PROJECTS_DIR_NAME = "projects";
/** The shared, machine-wide user mirror. */
const MEMORY_USER_DIR_NAME = "user";
/** Hex characters kept from the SHA-256 — enough to separate same-named repos. */
const PROJECT_HASH_HEX_CHARS = 8;
/** Anything outside the safe set is folded to a dash so the segment is one path component. */
const UNSAFE_SEGMENT_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * The slice of `Logger` the memory surfaces log through.
 *
 * Structurally assignable to nax-agent's `AgentLogger` (which feature 1's store,
 * sync and provider functions take), so a host can hand the same object to both.
 */
export type MemoryLogger = Pick<Logger, "warn" | "debug" | "info" | "error">;

/** Resolved memory mirror locations for one project. */
export interface MemoryDirs {
  /** `<globalConfigDir()>/memory` — parent of both mirrors. */
  readonly root: string;
  /** `<root>/projects/<segment>-<hash8>` — this project's mirror. */
  readonly projectDir: string;
  /** `<root>/user` — the machine-wide user mirror. */
  readonly userDir: string;
}

/**
 * Filesystem seam for tests. `realpath` is the only external call this module
 * makes, and a test needs to drive its rejection to exercise
 * `MEMORY_REPO_ROOT_UNRESOLVED` without an unreadable directory.
 */
export const _memoryPathsDeps: { realpath: (path: string) => Promise<string> } = {
  realpath: (path: string): Promise<string> => realpath(path),
};

/**
 * Fold a project key into a single safe path component.
 *
 * Keeps `[A-Za-z0-9._-]` and replaces every other character with `-`, so a
 * configured name such as `team/api v2` cannot escape the projects directory.
 *
 * @param projectKey - `getProjectKey()` output (configured name or basename)
 */
export function memoryProjectSegment(projectKey: string): string {
  return projectKey.replace(UNSAFE_SEGMENT_CHARS, "-");
}

/** First 8 lowercase hex characters of the SHA-256 of a canonical repo root. */
function projectHash8(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot, "utf8").digest("hex").slice(0, PROJECT_HASH_HEX_CHARS);
}

/**
 * Resolve `repoRoot` to its canonical path, or refuse.
 *
 * `realpath` is what makes the mirror identity stable across symlinked
 * checkouts; a failure means memory cannot be placed at all, so it is a
 * `NaxError` rather than a warning. The caller's original `repoRoot` is kept in
 * the context — the canonical path is not available on this path.
 */
async function canonicalRepoRoot(repoRoot: string): Promise<string> {
  try {
    return await _memoryPathsDeps.realpath(repoRoot);
  } catch (cause) {
    throw new NaxError(
      `[memory] cannot resolve repository root ${repoRoot}: ${errorMessage(cause)}`,
      "MEMORY_REPO_ROOT_UNRESOLVED",
      { stage: "memory", repoRoot, cause },
    );
  }
}

/**
 * Resolve the memory mirror directories for a project.
 *
 * Identity uses the canonical repository root, including the basename fallback
 * in `getProjectKey`: a symlink with a different basename must still resolve to
 * the same whole projectDir, not merely the same hash suffix.
 *
 * @param input.config - Loaded nax config (only `name` is read)
 * @param input.repoRoot - Absolute path to the repository root as the caller has it
 * @throws {NaxError} `MEMORY_REPO_ROOT_UNRESOLVED` when `realpath` fails
 */
export async function memoryDirs(input: {
  readonly config: Partial<Pick<NaxConfig, "name">>;
  readonly repoRoot: string;
}): Promise<MemoryDirs> {
  const canonicalRoot = await canonicalRepoRoot(input.repoRoot);
  const root = join(globalConfigDir(), MEMORY_DIR_NAME);
  const projectKey = getProjectKey({ name: input.config.name ?? "" }, canonicalRoot);
  const segment = memoryProjectSegment(projectKey);

  return {
    root,
    projectDir: join(root, MEMORY_PROJECTS_DIR_NAME, `${segment}-${projectHash8(canonicalRoot)}`),
    userDir: join(root, MEMORY_USER_DIR_NAME),
  };
}
