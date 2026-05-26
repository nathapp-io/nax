/**
 * Partition mock_structure TestEditDeclarations into valid/invalid.
 *
 * A declaration is valid when ALL its declared files:
 *   (a) exist on disk, AND
 *   (b) match at least one resolved test-file pattern regex.
 *
 * Non-mock_structure declarations pass through unchanged to `valid`.
 *
 * Injectable _deps for testability (default: Bun.file(p).exists()).
 */
import { join } from "node:path";
import type { ResolvedTestPatterns } from "@/test-runners";
import type { TestEditDeclaration } from "./test-edit-declaration";

export interface ValidateMockStructureDeps {
  fileExists?: (path: string) => Promise<boolean>;
}

const defaultFileExists = (p: string): Promise<boolean> => Bun.file(p).exists();

/**
 * Partition mock_structure declarations into valid/invalid.
 *
 * @param declarations - All declarations (any reason).
 * @param resolvedTestPatterns - Resolved test file patterns for the package.
 * @param packageDir - Absolute path to the package directory.
 * @param deps - Injectable deps for testing (fileExists override).
 * @returns { valid, invalid } — non-mock_structure always go to valid.
 */
export async function validateMockStructureFiles(
  declarations: TestEditDeclaration[],
  resolvedTestPatterns: ResolvedTestPatterns,
  packageDir: string,
  deps?: ValidateMockStructureDeps,
): Promise<{ valid: TestEditDeclaration[]; invalid: TestEditDeclaration[] }> {
  const fileExists = deps?.fileExists ?? defaultFileExists;
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
      const absolutePath = join(packageDir, file);
      const exists = await fileExists(absolutePath);
      if (!exists) {
        allValid = false;
        break;
      }
      // Test the relative file path (as stored in the declaration) against the regex
      const matchesPattern = resolvedTestPatterns.regex.some((re) => re.test(file));
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
