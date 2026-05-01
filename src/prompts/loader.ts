/**
 * Prompt Override Loader
 *
 * Resolves and reads user-supplied override files relative to workdir.
 */

import { join } from "node:path";
import type { NaxConfig } from "../config/types";
import type { PromptRole } from "./core/types";

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
  config: Pick<NaxConfig, "prompts">,
): Promise<string | null> {
  const overridePath = config.prompts?.overrides?.[role];

  if (!overridePath) {
    return null;
  }

  const absolutePath = join(workdir, overridePath);
  const file = Bun.file(absolutePath);

  if (!(await file.exists())) {
    return null;
  }

  try {
    return await file.text();
  } catch (err) {
    throw new Error(
      `Cannot read prompt override for role "${role}" at "${absolutePath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
