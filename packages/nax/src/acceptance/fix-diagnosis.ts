/**
 * Acceptance Fix Diagnosis — source-file loading for the diagnosis flow.
 *
 * Thin wrapper over the polyglot resolver in ./import-resolution. Kept as a
 * named seam because the acceptance diagnosis lifecycle imports it directly.
 */
import type { ProjectProfile } from "../config";
import { resolveSourceFiles } from "./import-resolution";

export interface LoadSourceFilesOptions {
  testFileContent: string;
  packageDir: string;
  testFilePath?: string;
  language?: ProjectProfile["language"];
}

export async function loadSourceFilesForDiagnosis(
  opts: LoadSourceFilesOptions,
): Promise<Array<{ path: string; content: string }>> {
  return resolveSourceFiles(opts);
}
