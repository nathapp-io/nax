import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadJsonFile, saveJsonFile } from "@/utils/json-file";
import { withTempDir } from "@test/helpers";

const WRITER_FIXTURE = join(import.meta.dir, "..", "..", "fixtures", "json-file-writer.ts");

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

  test("a reader in another process never observes a torn/partial write (rename is atomic)", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "data.json");
      // Seed the file so the first read has something to parse.
      await saveJsonFile(path, { items: [] }, "test");

      const proc = Bun.spawn(["bun", WRITER_FIXTURE, path], { stdout: "ignore", stderr: "inherit" });

      let nullReads = 0;
      let reads = 0;
      while (proc.exitCode === null && reads < 5000) {
        const loaded = await loadJsonFile<{ items: unknown[] }>(path, "test");
        reads++;
        if (loaded === null) nullReads++;
      }
      await proc.exited;
      // Drain a few more reads after the writer exits to catch a trailing torn state.
      for (let i = 0; i < 20; i++) {
        const loaded = await loadJsonFile<{ items: unknown[] }>(path, "test");
        reads++;
        if (loaded === null) nullReads++;
      }

      expect(proc.exitCode).toBe(0);
      expect(reads).toBeGreaterThan(0);
      expect(nullReads).toBe(0);
    });
  }, 15000);

  test("cleans up the temp file when rename() fails", async () => {
    await withTempDir(async (dir) => {
      // The destination is a directory, so Bun.write to the sibling .tmp-*
      // file succeeds but rename(tmpPath, path) fails with EISDIR.
      const path = join(dir, "subdir");
      mkdirSync(path);

      await expect(saveJsonFile(path, { a: 1 }, "test")).rejects.toThrow();

      const entries = readdirSync(dir);
      expect(entries).toEqual(["subdir"]);
    });
  });
});
