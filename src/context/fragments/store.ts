/**
 * Context Engine — Fragment Store
 *
 * Feature-scoped fragment persistence. One fragment per story at:
 *   <projectDir>/.nax/features/<featureId>/fragments/<storyId>.md
 *
 * `projectDir` is the repo root, so the `.nax` segment is required — it is what
 * puts fragments in the same feature directory as `prd.json` and the context
 * manifests (`manifest-store.ts`, `stage-assembler.ts` join it the same way).
 * Omitting it wrote fragments to a stray top-level `features/` dir that no
 * `.nax`-scoped gitignore entry covered.
 *
 * Attribution is the filename; the file body carries no metadata. Fragment
 * base score is 1.0 (matches the existing context.md chunk score).
 *
 * Capture from `completionStage`, LLM extraction, summarisation, promotion,
 * and cross-feature memory are deferred to later specs (US-002+).
 */

import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { featureDir } from "@/config";
import { estimateTokens } from "@/optimizer";
import { atomicWriteText } from "@/utils/json-file";

/** Injectable file I/O — tests override to use in-memory stores. */
export const _fragmentStoreDeps = {
  mkdirp: (path: string): Promise<string | undefined> => mkdir(path, { recursive: true }),
  /**
   * Tmp-write + rename, not a direct `Bun.write` — a concurrent reader (a
   * dependent story's `readFragment`/`listFragmentStoryIds` call under
   * parallel execution) must never observe a truncated mid-write file. Same
   * torn-read fix as `manifest-store.ts`'s `writeJson` (BUG-08).
   */
  writeFile: (path: string, content: string): Promise<void> => atomicWriteText(path, content, "fragments"),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  /**
   * Directory existence. Deliberately NOT `Bun.file(dir).exists()` — that
   * returns `false` for a directory, which silently disabled the entire
   * fragment read path (`listFragmentStoryIds` always returned `[]`).
   */
  directoryExists: async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  listFragments: async (fragmentsDir: string): Promise<string[]> => {
    const files: string[] = [];
    for await (const entry of new Bun.Glob("*.md").scan({ cwd: fragmentsDir, absolute: false })) {
      files.push(entry);
    }
    return files.sort();
  },
  removeFile: async (path: string): Promise<void> => {
    await rm(path, { force: true });
  },
};

/** Resolve the on-disk path for a fragment file. */
export function fragmentPath(projectDir: string, featureId: string, storyId: string): string {
  validatePathSegment(storyId, "storyId");
  return join(fragmentsDir(projectDir, featureId), `${storyId}.md`);
}

function fragmentsDir(projectDir: string, featureId: string): string {
  validatePathSegment(featureId, "featureId");
  return join(featureDir(projectDir, featureId), "fragments");
}

/**
 * Reject path-traversal in fragment identifiers. `featureId` and `storyId`
 * flow directly into a `node:path.join` call, and `join` silently collapses
 * `..` segments — e.g. `join("/repo", "features", "..", "etc", "fragments",
 * "x.md")` resolves to `/repo/etc/x.md`. Without this guard, an untrusted
 * caller could escape the feature fragments dir. Each id must be a single
 * non-empty path segment with no separators, NUL, or dot/dot-dot values.
 */
const NUL = "\0";
function validatePathSegment(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`[fragments] ${name} must be non-empty`);
  }
  if (value === "." || value === "..") {
    throw new Error(`[fragments] ${name} must not be '.' or '..'`);
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 47 /* '/' */ || c === 92 /* '\\' */ || c === NUL.charCodeAt(0)) {
      throw new Error(`[fragments] ${name} must not contain path separators or NUL`);
    }
  }
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
  // Prefer a line boundary so a fragment never ends mid-sentence. A single
  // line longer than the whole budget has no boundary to fall back to, so
  // the hard character cut stands rather than yielding an empty body.
  const lastBreak = candidate.lastIndexOf("\n");
  return lastBreak > 0 ? candidate.slice(0, lastBreak) : candidate;
}

/** Write a fragment body for a story, truncating if the body exceeds the budget. */
export async function writeFragment(
  projectDir: string,
  featureId: string,
  storyId: string,
  body: string,
  maxTokens: number,
): Promise<void> {
  const path = fragmentPath(projectDir, featureId, storyId);
  await _fragmentStoreDeps.mkdirp(dirname(path));
  const truncated = truncateToFragmentBudget(body, maxTokens);
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
  const dir = fragmentsDir(projectDir, featureId);
  // The fragments dir is created lazily on the first write. A cold-start
  // feature with no fragments yet has no dir — that is the expected "no
  // fragments" case and must return []. Other I/O failures (permissions,
  // corrupt paths) propagate so persistence problems aren't hidden as a
  // silent empty result.
  if (!(await _fragmentStoreDeps.directoryExists(dir))) return [];
  const files = await _fragmentStoreDeps.listFragments(dir);
  return files.map((file) => file.replace(/\.md$/, ""));
}

/** Delete a fragment for a story. Missing fragments are not an error. */
export async function deleteFragment(projectDir: string, featureId: string, storyId: string): Promise<void> {
  const path = fragmentPath(projectDir, featureId, storyId);
  if (!(await _fragmentStoreDeps.fileExists(path))) return;
  await _fragmentStoreDeps.removeFile(path);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fragment body (US-002 — stage 1 extractor)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the deterministic fragment body for a completed story. Pure function;
 * the calling stage (`completionStage`) supplies the inputs. The LLM-backed
 * extractor is deferred to a later spec.
 *
 * Layout:
 *   # <storyId> — <title>
 *
 *   ## Files touched
 *   - <changed-file-path>  (one per item, in order)
 *
 *   ## Acceptance criteria
 *   - <criterion>  (one per item, in order)
 *
 * Files come first deliberately. Bodies are truncated from the tail, and the
 * acceptance-criteria list is both the longer section and the one that blows
 * the budget — measured over real features, most bodies exceed the default
 * `maxTokens` and used to lose the file list entirely. The file list is the
 * shorter section and tells a dependent story where its dependency landed, so
 * it is the half worth keeping when only one survives.
 */
export function renderFragmentBody(
  storyId: string,
  title: string,
  acceptanceCriteria: readonly string[],
  changedFiles: readonly string[],
): string {
  const criteriaLines = acceptanceCriteria.map((c) => `- ${c}`).join("\n");
  const filesLines = changedFiles.map((f) => `- ${f}`).join("\n");
  return `# ${storyId} — ${title}\n\n## Files touched\n${filesLines}\n\n## Acceptance criteria\n${criteriaLines}\n`;
}
