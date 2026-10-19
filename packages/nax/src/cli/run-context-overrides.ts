/**
 * `nax run --rules-dir` / `--context-file` → config CLI overrides (US-002).
 *
 * Extracted from `bin/run-action.ts` for the same reason as `run-max-iterations.ts`
 * (US-001) and `run-parallel.ts` (US-002): `bin/` is a CLI entry point with no
 * unit test of its own, and `../../` imports are banned by `noRestrictedImports`,
 * so a mapping that lived inline there could not be tested at all.
 *
 * The path rule mirrors the config schema's (`context.rules.overrideDir`,
 * `context.projectContext.file`): absolute, or `~/`-prefixed and expanded at
 * parse time. A relative value is not resolvable by the schema — the process may
 * have been started in any directory — so the CLI anchors it on the run's
 * workdir (`nax run -d <dir>`), which is the only directory the operator named.
 */

import { isAbsolute, join } from "node:path";

/** The two flags this module reads off the `nax run` options object. */
export interface RunContextFlagOptions {
  /** `--rules-dir <path>` */
  rulesDir?: string;
  /** `--context-file <path>` */
  contextFile?: string;
}

/** A `context` block of CLI overrides, or `undefined` when neither flag was passed. */
export interface ContextCliOverrides {
  rules?: { overrideDir: string };
  projectContext?: { file: string };
}

/**
 * An absolute or `~/`-prefixed value passes through unchanged (the schema
 * expands `~/`); anything else is joined onto `workdir`.
 */
export function resolveCliOverridePath(workdir: string, value: string): string {
  return isAbsolute(value) || value.startsWith("~/") ? value : join(workdir, value);
}

/**
 * The `context` layer of `cliOverrides`, or `undefined` when neither flag was
 * passed — so an unset flag never replaces a configured value with `undefined`.
 */
export function resolveContextCliOverrides(
  workdir: string,
  options: RunContextFlagOptions,
): ContextCliOverrides | undefined {
  const overrides: ContextCliOverrides = {};
  if (options.rulesDir !== undefined) {
    overrides.rules = { overrideDir: resolveCliOverridePath(workdir, options.rulesDir) };
  }
  if (options.contextFile !== undefined) {
    overrides.projectContext = { file: resolveCliOverridePath(workdir, options.contextFile) };
  }
  return overrides.rules === undefined && overrides.projectContext === undefined ? undefined : overrides;
}
