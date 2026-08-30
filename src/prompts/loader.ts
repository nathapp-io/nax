/**
 * Prompt Override Loader
 *
 * Resolves and reads user-supplied override files relative to workdir.
 */

import { join } from "node:path";
import type { PromptLoaderConfig } from "@/config/selectors";
import type { PromptRole } from "./core/types";

/**
 * Filesystem seam, per the repo's `_deps` convention for external calls.
 *
 * Exists so the unreadable-file path below can be exercised without chmod. The
 * chmod-based tests are real but can only deny access to a non-root user, so they
 * are `fullTest`-gated and never run under the coverage gate; injecting here covers
 * the same branch deterministically, root or not.
 */
export const _promptLoaderDeps = {
  fileExists: (absolutePath: string): Promise<boolean> => Bun.file(absolutePath).exists(),
  readText: (absolutePath: string): Promise<string> => Bun.file(absolutePath).text(),
};

/**
 * Load a user override for the given role from the path specified in config.
 *
 * @param role - The prompt role
 * @param workdir - The project working directory
 * @param config - The merged NaxConfig
 * @returns The override file contents, or null if absent/missing
 * @throws Error when file path is set but file is unreadable (e.g. permissions error)
 */
export async function loadOverride(
  role: PromptRole,
  workdir: string,
  config: PromptLoaderConfig,
): Promise<string | null> {
  const overridePath = config.prompts?.overrides?.[role];

  if (!overridePath) {
    return null;
  }

  const absolutePath = join(workdir, overridePath);

  if (!(await _promptLoaderDeps.fileExists(absolutePath))) {
    return null;
  }

  try {
    return await _promptLoaderDeps.readText(absolutePath);
  } catch (err) {
    throw new Error(
      `Cannot read prompt override for role "${role}" at "${absolutePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
