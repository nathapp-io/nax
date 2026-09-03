/**
 * Configuration Path Utilities
 *
 * Provides path resolution for global and project-level config directories.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { NaxError } from "../errors";

const GLOBAL_CONFIG_DIR_ENV = "NAX_GLOBAL_CONFIG_DIR";

/**
 * Feature ID charset, mirroring `validateStoryId` (`src/prd/validate.ts`) but with
 * a leading underscore also allowed — `"_unattached"` (`src/pipeline/stages/context.ts`,
 * `src/context/engine/stage-assembler.ts`) is a real internal sentinel used when a
 * context request has no attached feature, and it must keep resolving through this
 * same path. Traversal (`..`) and a leading `--` (git-flag-shaped) are rejected
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
 *   an acceptance test resolves against its own package's imports).
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
 * Feeding Home: src/tools/tool-audit.ts writes one JSON file per session here.
 */
export function toolAuditDir(anchor: ToolAuditAnchor, featureId?: string): string {
  const outputDir = anchor.outputDir?.trim();
  const base = outputDir ? join(outputDir, "tool-audit") : join(anchor.root, PROJECT_NAX_DIR, "tool-audit");
  return featureId ? join(base, featureId) : base;
}
