/**
 * Context Engine — Fragment Store
 *
 * Feature-scoped fragment persistence. One fragment per story at:
 *   <projectDir>/features/<featureId>/fragments/<storyId>.md
 *
 * Attribution is the filename; the file body carries no metadata. Fragment
 * base score is 1.0 (matches the existing context.md chunk score).
 *
 * Capture from `completionStage`, LLM extraction, summarisation, promotion,
 * and cross-feature memory are deferred to later specs (US-002+).
 */

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { estimateTokens } from "../optimizer/types";

/** Injectable file I/O — tests override to use in-memory stores. */
export const _fragmentStoreDeps = {
  mkdirp: (path: string): Promise<string | undefined> => mkdir(path, { recursive: true }),
  writeFile: (path: string, content: string): Promise<number> => Bun.write(path, content),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  listFragments: async (fragmentsDir: string): Promise<string[]> => {
    try {
      const files: string[] = [];
      for await (const entry of new Bun.Glob("*.md").scan({ cwd: fragmentsDir, absolute: false })) {
        files.push(entry);
      }
      return files.sort();
    } catch {
      return [];
    }
  },
  removeFile: async (path: string): Promise<void> => {
    await rm(path, { force: true });
  },
};

/** Resolve the on-disk path for a fragment file. */
export function fragmentPath(projectDir: string, featureId: string, storyId: string): string {
  return join(projectDir, "features", featureId, "fragments", `${storyId}.md`);
}

function fragmentsDir(projectDir: string, featureId: string): string {
  return join(projectDir, "features", featureId, "fragments");
}

/** Truncate a body to fit within the given token budget. */
export function truncateToFragmentBudget(body: string, maxTokens: number): string {
  if (maxTokens < 1) return "";
  if (estimateTokens(body) <= maxTokens) return body;
  // Optimistic char-based truncation: tokens ≈ chars / 4. Re-estimate and
  // shrink as needed so the truncated body stays strictly within budget.
  let budget = Math.max(1, maxTokens) * 4;
  let candidate = body.slice(0, budget);
  while (estimateTokens(candidate) > maxTokens && candidate.length > 0) {
    budget -= 1;
    candidate = body.slice(0, budget);
  }
  return candidate;
}

export interface WriteFragmentOptions {
  /** Token budget applied before writing. Bodies longer than this are truncated. */
  maxTokens: number;
}

/** Write a fragment body for a story, truncating if the body exceeds the budget. */
export async function writeFragment(
  projectDir: string,
  featureId: string,
  storyId: string,
  body: string,
  options: WriteFragmentOptions,
): Promise<void> {
  const path = fragmentPath(projectDir, featureId, storyId);
  await _fragmentStoreDeps.mkdirp(dirname(path));
  const truncated = truncateToFragmentBudget(body, options.maxTokens);
  await _fragmentStoreDeps.writeFile(path, truncated);
}

/** Read the fragment body for a story. Returns null if the fragment does not exist. */
export async function readFragment(projectDir: string, featureId: string, storyId: string): Promise<string | null> {
  const path = fragmentPath(projectDir, featureId, storyId);
  if (!(await _fragmentStoreDeps.fileExists(path))) return null;
  return await _fragmentStoreDeps.readFile(path);
}

/** List the story ids that have a fragment under the given feature. */
export async function listFragmentStoryIds(projectDir: string, featureId: string): Promise<string[]> {
  const files = await _fragmentStoreDeps.listFragments(fragmentsDir(projectDir, featureId));
  return files.map((file) => file.replace(/\.md$/, ""));
}

/** Delete a fragment for a story. Missing fragments are not an error. */
export async function deleteFragment(projectDir: string, featureId: string, storyId: string): Promise<void> {
  const path = fragmentPath(projectDir, featureId, storyId);
  if (!(await _fragmentStoreDeps.fileExists(path))) return;
  await _fragmentStoreDeps.removeFile(path);
}
