/**
 * Partition mock_structure TestEditDeclarations into valid/invalid.
 *
 * A declaration is valid when ALL its declared files:
 *   (a) exist on disk under `packageDir` or (when supplied) `repoRoot`, AND
 *   (b) match at least one resolved test-file pattern regex, tested against the
 *       path rebased to be package-relative.
 *
 * Two anchors are tried because the declaration's paths come from an LLM that
 * reads findings rendered repo-relative, while `resolvedTestPatterns` and the
 * per-package config are package-relative. Anchoring on `packageDir` alone
 * double-prefixed repo-relative declarations in monorepos, rejecting real test
 * files as nonexistent and deadlocking the story (#1385).
 *
 * Non-mock_structure declarations pass through unchanged to `valid`.
 *
 * Injectable _deps for testability (default: Bun.file(p).exists()).
 */
import { isAbsolute, join, relative } from "node:path";
import type { ResolvedTestPatterns } from "@/test-runners";
import type { TestEditDeclaration } from "./test-edit-declaration";

export interface ValidateMockStructureOptions {
  fileExists?: (path: string) => Promise<boolean>;
  /**
   * Absolute repo root, used as a secondary resolution anchor when the agent
   * declares repo-relative paths. Omit for single-package repos, where it is
   * equal to `packageDir` and adds no candidate.
   */
  repoRoot?: string;
}

const defaultFileExists = (p: string): Promise<boolean> => Bun.file(p).exists();

/** Candidate absolute paths for a declared file, package-relative anchor first. */
function resolutionCandidates(file: string, packageDir: string, repoRoot?: string): string[] {
  if (isAbsolute(file)) return [file];
  const candidates = [join(packageDir, file)];
  if (repoRoot !== undefined) {
    const viaRepoRoot = join(repoRoot, file);
    if (viaRepoRoot !== candidates[0]) candidates.push(viaRepoRoot);
  }
  return candidates;
}

/**
 * Partition mock_structure declarations into valid/invalid.
 *
 * @param declarations - All declarations (any reason).
 * @param resolvedTestPatterns - Resolved test file patterns for the package.
 * @param packageDir - Absolute path to the story's package directory.
 * @param opts - Injectable fileExists plus the optional `repoRoot` anchor.
 * @returns { valid, invalid } — non-mock_structure always go to valid.
 */
export async function validateMockStructureFiles(
  declarations: TestEditDeclaration[],
  resolvedTestPatterns: ResolvedTestPatterns,
  packageDir: string,
  opts?: ValidateMockStructureOptions,
): Promise<{ valid: TestEditDeclaration[]; invalid: TestEditDeclaration[] }> {
  const fileExists = opts?.fileExists ?? defaultFileExists;
  const valid: TestEditDeclaration[] = [];
  const invalid: TestEditDeclaration[] = [];

  for (const d of declarations) {
    if (d.reason !== "mock_structure") {
      valid.push(d);
      continue;
    }

    const files = d.files ?? [d.file];

    // Check all files: must exist on disk AND match at least one test pattern regex
    let allValid = true;
    for (const file of files) {
      let resolved: string | null = null;
      for (const candidate of resolutionCandidates(file, packageDir, opts?.repoRoot)) {
        if (await fileExists(candidate)) {
          resolved = candidate;
          break;
        }
      }
      if (resolved === null) {
        allValid = false;
        break;
      }
      // Patterns are package-relative, so test the resolved path rebased onto
      // packageDir — never the raw declared string, whose anchor is unknown.
      const packageRelative = relative(packageDir, resolved);
      const matchesPattern = resolvedTestPatterns.regex.some((re) => re.test(packageRelative));
      if (!matchesPattern) {
        allValid = false;
        break;
      }
    }

    if (allValid) {
      valid.push(d);
    } else {
      invalid.push(d);
    }
  }

  return { valid, invalid };
}
