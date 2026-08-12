import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadJsonFile, saveJsonFile } from "../../../src/utils/json-file";
import { withTempDir } from "../../helpers/temp";

describe("saveJsonFile (BUG-08: atomic write)", () => {
  test("round-trips data through loadJsonFile", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "data.json");
      await saveJsonFile(path, { a: 1, b: [2, 3] }, "test");
      const loaded = await loadJsonFile<{ a: number; b: number[] }>(path, "test");
      expect(loaded).toEqual({ a: 1, b: [2, 3] });
    });
  });

  test("leaves no leftover .tmp-* file after a successful write", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "data.json");
      await saveJsonFile(path, { a: 1 }, "test");
      const entries = readdirSync(dir);
      expect(entries).toEqual(["data.json"]);
    });
  });

  test("a reader never observes a torn/partial write (rename is atomic)", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "data.json");
      const large = { items: Array.from({ length: 5000 }, (_, i) => ({ id: i, note: "x".repeat(50) })) };
      await saveJsonFile(path, large, "test");

      // A second write races a concurrent load — the loader must always see
      // either the old complete content or the new complete content.
      const writePromise = saveJsonFile(path, { items: [{ id: -1, note: "replaced" }] }, "test");
      const loaded = await loadJsonFile<{ items: unknown[] }>(path, "test");
      await writePromise;

      expect(loaded).not.toBeNull();
      expect(Array.isArray(loaded?.items)).toBe(true);
    });
  });

  test("cleans up the temp file when the write fails", async () => {
    await withTempDir(async (dir) => {
      // Directory as the destination path makes Bun.write fail (EISDIR).
      const path = join(dir, "subdir");
      mkdirSync(path);

      await expect(saveJsonFile(path, { a: 1 }, "test")).rejects.toThrow();

      const entries = readdirSync(dir);
      expect(entries).toEqual(["subdir"]);
    });
  });
});
