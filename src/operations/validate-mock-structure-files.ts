/**
 * Partition mock_structure TestEditDeclarations into valid/invalid.
 *
 * A declaration is valid when ALL its declared files:
 *   (a) exist on disk under `packageDir` or (when supplied) `repoRoot`, AND
 *   (b) resolve to a path *inside* `packageDir`, AND
 *   (c) match at least one resolved test-file pattern regex, tested against the
 *       path rebased to be package-relative.
 *
 * Two anchors are tried because the declaration's paths come from an LLM that
 * reads findings rendered repo-relative, while `resolvedTestPatterns` and the
 * per-package config are package-relative. Anchoring on `packageDir` alone
 * double-prefixed repo-relative declarations in monorepos, rejecting real test
 * files as nonexistent and deadlocking the story (#1385).
 *
 * Containment (b) keeps the second anchor from widening scope: resolver regexes
 * are typically unanchored, so without it a repo-relative path naming another
 * package's tests would now match and be handed to a test-writer that may only
 * edit inside its own package. Cross-package spillover routes through the
 * sibling_scope declaration instead.
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
  const viaPackageDir = join(packageDir, file);
  if (repoRoot === undefined) return [viaPackageDir];
  const viaRepoRoot = join(repoRoot, file);
  // Equal in a single-package repo — probe once rather than twice.
  return viaRepoRoot === viaPackageDir ? [viaPackageDir] : [viaPackageDir, viaRepoRoot];
}

interface ResolveOptions {
  packageDir: string;
  repoRoot?: string;
  fileExists: (path: string) => Promise<boolean>;
}

/**
 * Resolve a declared file to its package-relative path.
 *
 * Returns null when the file exists under no anchor, or when the first anchor it
 * does exist under places it outside `packageDir` — see containment in the module
 * header. A path that escapes under one anchor escapes under both, so the first
 * hit is decisive.
 */
async function resolvePackageRelative(file: string, opts: ResolveOptions): Promise<string | null> {
  for (const candidate of resolutionCandidates(file, opts.packageDir, opts.repoRoot)) {
    if (!(await opts.fileExists(candidate))) continue;
    const rel = relative(opts.packageDir, candidate);
    // "" means the path IS packageDir; ".." escapes it; absolute means a
    // different root entirely.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel;
  }
  return null;
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

    // Check all files: must resolve inside the package AND match a test pattern.
    let allValid = true;
    for (const file of files) {
      const packageRelative = await resolvePackageRelative(file, {
        packageDir,
        repoRoot: opts?.repoRoot,
        fileExists,
      });
      if (packageRelative === null) {
        allValid = false;
        break;
      }
      // Patterns are package-relative, so test the resolved path rebased onto
      // packageDir — never the raw declared string, whose anchor is unknown.
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
