import { describe, expect, test } from "bun:test";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { relativeInsideRoot } from "@/finish/safe-path";

describe("relativeInsideRoot()", () => {
  test("returns the posix-separated path of a nested directory inside the root", async () => {
    await withTempDir(async (root) => {
      const nested = join(root, "audit", "nested");
      await mkdir(nested, { recursive: true });
      expect(await relativeInsideRoot(root, nested)).toBe("audit/nested");
    });
  });

  test("returns null for the root itself, so a caller never resets the whole repo", async () => {
    await withTempDir(async (root) => {
      expect(await relativeInsideRoot(root, root)).toBeNull();
    });
  });

  test("returns null for a directory outside the root", async () => {
    await withTempDir(async (root) => {
      await withTempDir(async (other) => {
        expect(await relativeInsideRoot(root, other)).toBeNull();
      });
    });
  });

  test("compares real paths, not string prefixes — a sibling sharing the root name is outside", async () => {
    await withTempDir(async (parent) => {
      const root = join(parent, "repo");
      const sibling = join(parent, "repo-other");
      await mkdir(root, { recursive: true });
      await mkdir(sibling, { recursive: true });
      expect(await relativeInsideRoot(root, sibling)).toBeNull();
    });
  });

  test("follows a symlink to its real target — a link inside the root pointing outside is outside", async () => {
    await withTempDir(async (root) => {
      await withTempDir(async (outside) => {
        const link = join(root, "link");
        await symlink(outside, link);
        expect(await relativeInsideRoot(root, link)).toBeNull();
      });
    });
  });

  test("resolves a symlink that stays inside the root to its real relative path", async () => {
    await withTempDir(async (root) => {
      const target = join(root, "real-dir");
      await mkdir(target, { recursive: true });
      const link = join(root, "link");
      await symlink(target, link);
      expect(await relativeInsideRoot(root, link)).toBe("real-dir");
    });
  });

  test("resolves a path whose tail does not exist yet, appending the missing segments", async () => {
    await withTempDir(async (root) => {
      expect(await relativeInsideRoot(root, join(root, "missing", "deeper"))).toBe("missing/deeper");
    });
  });

  test("treats a plain file inside the root as inside", async () => {
    await withTempDir(async (root) => {
      const file = join(root, "audit.json");
      await writeFile(file, "{}");
      expect(await relativeInsideRoot(root, file)).toBe("audit.json");
    });
  });

  test("resolves a root expressed through a symlinked path to the same answer", async () => {
    await withTempDir(async (parent) => {
      const root = join(parent, "repo");
      await mkdir(join(root, "audit"), { recursive: true });
      const linkedRoot = join(parent, "root-link");
      await symlink(root, linkedRoot);
      expect(await relativeInsideRoot(linkedRoot, join(root, "audit"))).toBe("audit");
      expect(await relativeInsideRoot(await realpath(root), join(root, "audit"))).toBe("audit");
    });
  });
});
