/**
 * Persisting the PRD to disk.
 *
 * A leaf, deliberately: `progress-commit.ts` must save the PRD before it
 * commits it, and importing `savePRD` from `./index` would make the barrel and
 * that module a two-module runtime import cycle (the barrel re-exports it) —
 * which `check:import-cycles` rejects. The barrel re-exports this module, so
 * `savePRD` keeps its identity and its `@/prd` specifier.
 */

import { saveJsonFile } from "../utils/json-file";
import { stripPropagatedOutOfScope } from "./out-of-scope";
import type { PRD } from "./types";

/** Save PRD to file */
export async function savePRD(prd: PRD, path: string): Promise<void> {
  prd.updatedAt = new Date().toISOString();
  await saveJsonFile(path, stripPropagatedOutOfScope(prd), "prd");
}
