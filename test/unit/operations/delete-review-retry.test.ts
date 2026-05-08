import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { Glob } from "bun";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "../../../");

describe("Delete _review-retry.ts cleanup", () => {
  test("_review-retry.ts file should not exist", () => {
    const path = join(REPO_ROOT, "src/operations/_review-retry.ts");
    expect(existsSync(path)).toBe(false);
  });

  test("no imports of _review-retry exist in src/", async () => {
    const glob = new Glob("src/**/*.ts");
    const files = Array.from(glob.scanSync({ cwd: REPO_ROOT, absolute: false }));

    let foundImports = false;
    for (const file of files) {
      const filePath = join(REPO_ROOT, file);
      const content = await Bun.file(filePath).text();
      if (
        content.includes("from") &&
        (content.includes("_review-retry") || content.includes("makeReviewRetryHopBody"))
      ) {
        foundImports = true;
        console.log(`Found import in ${file}`);
      }
    }

    expect(foundImports).toBe(false);
  });

  test("no imports of _review-retry exist in test/", async () => {
    const glob = new Glob("test/**/*.ts");
    const files = Array.from(glob.scanSync({ cwd: REPO_ROOT, absolute: false }));

    let foundImports = false;
    for (const file of files) {
      // Exclude this test file itself
      if (file === "test/unit/operations/delete-review-retry.test.ts") continue;

      const filePath = join(REPO_ROOT, file);
      const content = await Bun.file(filePath).text();
      if (
        content.includes("from") &&
        (content.includes("_review-retry") || content.includes("makeReviewRetryHopBody"))
      ) {
        foundImports = true;
        console.log(`Found import in ${file}`);
      }
    }

    expect(foundImports).toBe(false);
  });
});
