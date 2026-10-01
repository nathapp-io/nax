/**
 * package-config.ts — per-package config resolution that cannot drop the profile chain.
 *
 * `loadConfigForWorkdir` takes its CLI overrides as an optional trailing argument,
 * so every call site is free to omit the run's `--profile` chain. For a config that
 * only feeds data fields (`acceptance.command`, `project.testFramework`) that is
 * invisible; for one handed to `callOp` as `ctx.config` it is fatal, because the
 * model map usually lives in the profile and dispatch then throws MODEL_NOT_FOUND
 * (nax#2126 — the acceptance-setup stage resolved a profile-less group config and
 * every `native` dispatch in it failed at tier `fast`).
 *
 * This helper takes the run config it must inherit the chain from as a REQUIRED
 * argument, so the chain cannot be dropped by omission. Per-package resolution in
 * new code goes through here; `scripts/check-config-profile-threading.ts` keeps
 * direct `loadConfigForWorkdir` call sites honest.
 */

import { join } from "node:path";
import { loadConfigForWorkdir } from "./loader";
import { PROJECT_NAX_DIR } from "./paths";
import { profileOverrideFromConfig } from "./profile";
import type { NaxConfig } from "./types";

/**
 * Resolve the effective config for `packageDir`, inheriting `from`'s profile chain.
 *
 * @param projectDir - Repo root (the directory holding `.nax/`).
 * @param packageDir - Package path relative to the repo root; falsy or "." means the root.
 * @param from - The run config whose `--profile` chain the result must inherit.
 */
export function loadConfigForPackage(
  projectDir: string,
  packageDir: string | undefined,
  from: NaxConfig,
): Promise<NaxConfig> {
  const rootConfigPath = join(projectDir, PROJECT_NAX_DIR, "config.json");
  const relative = packageDir && packageDir !== "." ? packageDir : undefined;
  return loadConfigForWorkdir(rootConfigPath, relative, profileOverrideFromConfig(from));
}
