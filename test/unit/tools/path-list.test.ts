import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { pathListElements } from "@/tools/path-list";

// US-002: `pathListElements` widens the evidence that a `{{files}}` value is
// really a LIST. A multi-token value splits when any token is an existing
// file OR directory, or when every token looks like a path (contains a path
// separator or ends in a file extension) — so directories and not-yet-created
// test paths split too. Name filters and a single path containing a space stay
// whole. The single-token and empty/whitespace contracts are unchanged.
describe("pathListElements", () => {
  test("US-002 AC1: two existing directories split into one element each", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "test", "unit"), { recursive: true });
      await mkdir(join(root, "test", "integration"), { recursive: true });

      expect(pathListElements("test/unit test/integration", root)).toEqual(["test/unit", "test/integration"]);
    });
  });

  test("US-002 AC2: two existing directories with trailing separators split into one element each", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "test", "unit"), { recursive: true });
      await mkdir(join(root, "test", "integration"), { recursive: true });

      expect(pathListElements("test/unit/ test/integration/", root)).toEqual(["test/unit/", "test/integration/"]);
    });
  });

  test("US-002 AC3: two non-existent path-shaped tokens split into one element each", async () => {
    await withTempDir(async (root) => {
      expect(pathListElements("test/generated.py lib/generated.go", root)).toEqual([
        "test/generated.py",
        "lib/generated.go",
      ]);
    });
  });

  test("US-002 AC4: an existing directory and a non-existent path-shaped token split", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "src"), { recursive: true });

      expect(pathListElements("src dist/generated.js", root)).toEqual(["src", "dist/generated.js"]);
    });
  });

  test("US-002 AC5: two tokens with no path separator or extension stay whole (name filter)", async () => {
    await withTempDir(async (root) => {
      expect(pathListElements("test_a test_b", root)).toEqual(["test_a test_b"]);
    });
  });

  test("US-002 AC6: a single existing file whose own name contains a space stays whole", async () => {
    await withTempDir(async (root) => {
      await writeFile(join(root, "my file.test.ts"), "// a\n");

      expect(pathListElements("my file.test.ts", root)).toEqual(["my file.test.ts"]);
    });
  });

  test("US-002 AC7: a one-token value returns one element equal to that value", () => {
    expect(pathListElements("a.test.ts", "/tmp/no-such-root")).toEqual(["a.test.ts"]);
  });

  test("US-002 AC8: a whitespace-only value returns exactly one element, never an empty list", () => {
    expect(pathListElements("   ", "/tmp/no-such-root")).toEqual(["   "]);
  });

  test("US-002 AC9: a name filter mixed with a path-shaped token, nothing on disk, stays whole", async () => {
    await withTempDir(async (root) => {
      expect(pathListElements("filter test/generated.py", root)).toEqual(["filter test/generated.py"]);
    });
  });
});
