/**
 * Semantic Verdict Persistence
 *
 * Writes per-story semantic review verdicts to
 * <featureDir>/semantic-verdicts/<storyId>.json so they survive the GC
 * in iteration-runner.ts and are available to the acceptance loop.
 */

import path from "node:path";
import { reviewFindingToFinding } from "../findings";
import { getLogger } from "../logger";
import type { SemanticVerdict } from "./types";
export type { SemanticVerdict } from "./types";

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
  const dir = path.join(featureDir, "semantic-verdicts");
  await _semanticVerdictDeps.mkdirp(dir);
  const filePath = path.join(dir, `${storyId}.json`);
  await _semanticVerdictDeps.writeFile(filePath, JSON.stringify(verdict, null, 2));
}

/**
 * Migrate a verdict that may have been persisted with the old ReviewFinding shape
 * (pre-ADR-021-phase-7). Detection: a finding with `ruleId` but no `source` field
 * is a legacy ReviewFinding — convert it via reviewFindingToFinding.
 */
function migrateSemanticVerdict(verdict: SemanticVerdict): SemanticVerdict {
  if (!verdict.findings?.length) return verdict;
  const first = verdict.findings[0] as unknown as Record<string, unknown>;
  if ("source" in first) return verdict;
  return {
    ...verdict,
    findings: (verdict.findings as unknown as Array<unknown>).map((f) =>
      reviewFindingToFinding(f as Parameters<typeof reviewFindingToFinding>[0]),
    ),
  };
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
  const dir = path.join(featureDir, "semantic-verdicts");
  let files: string[];
  try {
    files = await _semanticVerdictDeps.readdir(dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: SemanticVerdict[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const filePath = path.join(dir, file);
    const content = await _semanticVerdictDeps.readFile(filePath);
    try {
      const parsed = JSON.parse(content) as SemanticVerdict;
      results.push(migrateSemanticVerdict(parsed));
    } catch {
      _semanticVerdictDeps.logDebug(`Skipping invalid JSON in semantic-verdicts/${file}`);
    }
  }
  return results;
}
