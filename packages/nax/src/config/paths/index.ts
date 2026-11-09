/**
 * Configuration Path Utilities
 *
 * Provides path resolution for global and project-level config directories.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NaxError } from "@/errors";
import { MAX_DIRECTORY_DEPTH } from "../path-security";

const GLOBAL_CONFIG_DIR_ENV = "NAX_GLOBAL_CONFIG_DIR";

/**
 * Feature ID charset, mirroring `validateStoryId` (`src/prd/validate.ts`) but with
 * a leading underscore also allowed — `"_unattached"` (`src/pipeline/stages/context.ts`)
 * is a real internal sentinel used when a context request has no attached
 * feature, and it must keep resolving through this same path. Traversal (`..`)
 * and a leading `--` (git-flag-shaped) are rejected
 * explicitly first so the error names the actual problem instead of a generic
 * pattern mismatch.
 */
const FEATURE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}$/;

/**
 * SEC-3 (code review 2026-08-17): `featureDir` is the SSOT anchor for every
 * feature-tree path (~38 call sites — `mkdir(recursive)`, artifact writes) but,
 * unlike `validateStoryId`, took `featureId` unvalidated. `featureId` today only
 * ever comes from the trusted CLI `--feature` flag, but the asymmetry with the
 * story-ID path was a real gap should that ever change.
 */
function validateFeatureId(featureId: string): void {
  if (!featureId || featureId.length === 0) {
    throw new NaxError("Feature ID cannot be empty", "INVALID_FEATURE_ID", { stage: "config" });
  }
  if (featureId.includes("..")) {
    throw new NaxError("Feature ID cannot contain path traversal (..)", "INVALID_FEATURE_ID", {
      stage: "config",
      featureId,
    });
  }
  if (featureId.startsWith("--")) {
    throw new NaxError("Feature ID cannot start with git flags (--)", "INVALID_FEATURE_ID", {
      stage: "config",
      featureId,
    });
  }
  if (!FEATURE_ID_PATTERN.test(featureId)) {
    throw new NaxError(
      `Feature ID must match pattern [a-zA-Z0-9_][a-zA-Z0-9._-]{0,63}. Got: ${featureId}`,
      "INVALID_FEATURE_ID",
      { stage: "config", featureId },
    );
  }
}

/**
 * Returns the global config directory path (~/.nax).
 *
 * @returns Absolute path to global config directory
 */
export function globalConfigDir(): string {
  const override = process.env[GLOBAL_CONFIG_DIR_ENV];
  if (override) return override;
  return join(homedir(), ".nax");
}

/**
 * Project names nax reserves for the directories it owns under
 * {@link globalConfigDir}.
 *
 * A project named after one of these collides with a directory nax itself
 * creates there: `nax migrate --reclaim profiles` would rename
 * `~/.nax/profiles/` into `~/.nax/_archive/` and take every named profile with
 * it. `validateProjectName` (`src/cli/init.ts`) and the `NaxConfigSchema`
 * `name` refine (`src/config/schemas.ts`) both read this list, so `nax init`,
 * config validation and `nax migrate --reclaim` / `--merge` refuse the same
 * names.
 *
 * The list covers every directory nax creates under `globalConfigDir()`:
 *
 * - `global` — `src/runtime/paths.ts` (`globalOutputDir`)
 * - `profiles` — `src/config/profile.ts` (`loadProfile`)
 * - `runs` — `src/utils/paths.ts` (`getRunsDir`)
 * - `events` — `src/utils/paths.ts` (`getEventsRootDir`)
 * - `plugins` — `src/cli/plugins.ts`
 * - `acp` — `src/agents/acp/open-context.ts` (`acpStateDir`)
 * - `memory` — `src/memory/paths.ts` (`memoryDirs`)
 * - `hooks` — `src/cli/init.ts` (`initGlobalConfig`)
 * - `_archive` — `src/commands/migrate.ts` (the reclaim archive)
 *
 * Validation only: nax's own path helpers still spell these directory names
 * inline.
 */
export const RESERVED_PROJECT_NAMES: readonly string[] = [
  "global",
  "profiles",
  "runs",
  "events",
  "plugins",
  "acp",
  "memory",
  "hooks",
  "_archive",
];

/**
 * Hidden project config directory name.
 * Single source of truth — all code uses this constant or projectConfigDir().
 */
export const PROJECT_NAX_DIR = ".nax";

/**
 * Returns the project config directory path (projectRoot/.nax).
 *
 * @param projectRoot - Absolute or relative path to project root
 * @returns Absolute path to project config directory
 */
export function projectConfigDir(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_NAX_DIR);
}

/**
 * Feature-tree directory name, relative to a project root (`.nax/features`).
 *
 * For patterns rather than paths — globs, `.gitignore` entries, precheck
 * matchers — where a joined absolute path would be wrong. Always POSIX-separated
 * because every consumer of it is a pattern language, not the filesystem API.
 */
export const PROJECT_FEATURES_DIR = `${PROJECT_NAX_DIR}/features`;

/**
 * Absolute path to the feature tree (`<root>/.nax/features`).
 *
 * Deliberately a plain `join`, not `projectConfigDir()`: that helper calls
 * `resolve()`, which would rebase a relative root against the current working
 * directory. Every caller here already holds an absolute anchor, and silently
 * absolutising a relative one would mask a caller bug rather than surface it.
 *
 * @param root - Repo root for repo-scoped features; a package root for
 *   package-scoped ones (monorepos keep a `.nax/features` tree per package, so
 *   an artifact written there resolves against its own package's imports).
 */
export function featuresDir(root: string): string {
  return join(root, PROJECT_NAX_DIR, "features");
}

/**
 * Absolute path to one feature's directory (`<root>/.nax/features/<featureId>`).
 *
 * This is the single source of truth for where a feature's artifacts live —
 * `prd.json`, `status.json`, `stories/`, `sessions/`, `fragments/`, `context.md`.
 * Build every one of those by joining onto this, never by re-spelling `.nax`.
 * Fragments shipped writing to a stray top-level `features/` dir precisely
 * because the segment was open-coded at each site and one site dropped `.nax`.
 */
export function featureDir(root: string, featureId: string): string {
  validateFeatureId(featureId);
  return join(featuresDir(root), featureId);
}

/** Where a tool-audit ledger may be anchored, in precedence order. */
export interface ToolAuditAnchor {
  /**
   * The run's output directory (`~/.nax/<project>` by default, see
   * `projectOutputDir`). Preferred whenever a run supplies one.
   */
  outputDir?: string;
  /** The permitted tool root. Used only as the no-output-dir fallback. */
  root: string;
}

/**
 * Absolute path to the tool-audit tree.
 *
 * Precedence deliberately mirrors its two siblings — prompt-audit
 * (`src/runtime/index.ts`, `join(outputDir, "prompt-audit")`) and review-audit
 * (`src/review/review-audit.ts`, `join(entry.outputDir, "review-audit", ...)`).
 * The run output dir wins; the repo-local `.nax` path is the fallback for a run
 * that has none, which is the same thing `NAX_GITIGNORE_ENTRIES` documents for
 * finish-audit ("Only reached when a run has no outputDir").
 *
 * C2 shipped the fallback as the *only* path, and that was not merely
 * inconsistent: `root` is `codingToolRoot`, i.e. the story's package workdir
 * inside the git worktree, and `pipeline-result-handler.ts` runs
 * `git worktree remove --force` on completion. The ledger was therefore deleted
 * by the very run that produced it — the #1359 false-zero shape this ledger
 * exists to prevent, reintroduced by its own location.
 *
 * Feeding Home: packages/nax-agent/src/tools/tool-audit.ts writes one JSON file per session here.
 */
export function toolAuditDir(anchor: ToolAuditAnchor, featureId?: string): string {
  const outputDir = anchor.outputDir?.trim();
  const base = outputDir ? join(outputDir, "tool-audit") : join(anchor.root, PROJECT_NAX_DIR, "tool-audit");
  return featureId ? join(base, featureId) : base;
}

/**
 * Per-machine half of the global layer, next to `config.json` in `globalConfigDir()`.
 * It is deep-merged over `config.json`, so a global dir shared across machines can
 * keep machine-specific settings (an `auth.exec.command` path) out of the shared file.
 */
export const GLOBAL_LOCAL_CONFIG_FILE = "config.local.json";

/** `path` with symlinks resolved, or just absolutized when it does not exist. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A missing path has no symlinks to follow; compare it by its absolute form.
    return resolve(path);
  }
}

/**
 * True when `naxDir` is the global config dir, also when either side is reached
 * through a symlink (a synced repo linked to `~/.nax`, or `NAX_GLOBAL_CONFIG_DIR`
 * pointing at a link).
 */
export function isGlobalConfigDir(naxDir: string): boolean {
  return canonicalPath(naxDir) === canonicalPath(globalConfigDir());
}

/**
 * Find the project `.nax/` directory by walking up from `startDir`.
 *
 * The global config dir is never a project (#2827): started anywhere under the
 * directory that holds `~/.nax` with no nearer project config, the walk would
 * otherwise return the global dir and its config would load a second time as
 * the project layer, where global-only keys such as `auth` are rejected.
 *
 * Takes no cwd default on purpose: `process.cwd()` is a CLI-boundary bootstrap
 * value, and this module is imported from everywhere. Callers at that boundary
 * (`loadConfig`, the CLI commands) pass `process.cwd()` themselves.
 */
export function findProjectDir(startDir: string): string | null {
  let dir = resolve(startDir);
  let depth = 0;

  while (depth < MAX_DIRECTORY_DEPTH) {
    const candidate = join(dir, PROJECT_NAX_DIR);
    if (existsSync(join(candidate, "config.json")) && !isGlobalConfigDir(candidate)) {
      return candidate;
    }
    const parent = join(dir, "..");
    if (parent === dir) break; // Root reached
    dir = parent;
    depth++;
  }

  return null;
}
