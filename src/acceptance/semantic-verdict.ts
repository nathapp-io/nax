/**
 * Semantic Verdict Persistence
 *
 * Writes per-story semantic review verdicts to
 * <featureDir>/semantic-verdicts/<storyId>.json so they survive the GC
 * in iteration-runner.ts and are available to the acceptance loop.
 */

import path from "node:path";
import { getLogger } from "../logger";
import type { SemanticVerdict } from "./types";

/**
 * Injectable dependencies for semantic verdict persistence.
 * Allows tests to mock file I/O without touching Bun globals.
 */
export const _semanticVerdictDeps = {
  mkdirp: async (dir: string): Promise<void> => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
  },
  writeFile: async (filePath: string, content: string): Promise<void> => {
    await Bun.write(filePath, content);
  },
  readdir: async (dir: string): Promise<string[]> => {
    const { readdir } = await import("node:fs/promises");
    return readdir(dir);
  },
  readFile: async (filePath: string): Promise<string> => {
    return Bun.file(filePath).text();
  },
  logDebug: (msg: string): void => {
    getLogger()?.debug("semantic-verdict", msg);
  },
};

/**
 * Persist a semantic review verdict for a story to disk.
 *
 * Writes JSON to <featureDir>/semantic-verdicts/<storyId>.json.
 * Creates the semantic-verdicts subdirectory if it does not exist.
 *
 * @param featureDir - Feature directory (e.g. .nax/features/<feature>)
 * @param storyId - Story ID (used as the filename)
 * @param verdict - The semantic verdict to persist
 */
export async function persistSemanticVerdict(
  featureDir: string,
  storyId: string,
  verdict: SemanticVerdict,
): Promise<void> {
  // TODO: implement in US-003
  void featureDir;
  void storyId;
  void verdict;
}

/**
 * Load all semantic verdicts from <featureDir>/semantic-verdicts/.
 *
 * Returns an empty array when the directory does not exist or is empty.
 * Skips files that fail JSON.parse and logs a debug warning for each.
 *
 * @param featureDir - Feature directory (e.g. .nax/features/<feature>)
 * @returns Array of parsed SemanticVerdict objects
 */
export async function loadSemanticVerdicts(featureDir: string): Promise<SemanticVerdict[]> {
  // TODO: implement in US-003
  void featureDir;
  return [];
}
