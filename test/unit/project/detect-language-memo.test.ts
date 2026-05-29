/**
 * Unit tests for detectLanguage memoization (B1).
 *
 * Verifies that calling detectLanguage twice on the same directory
 * returns the same cached reference (no second filesystem read).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { clearLanguageCache, detectLanguage, _detectorDeps } from "../../../src/project/detector";
import { withTempDir } from "../../helpers/temp";

describe("detectLanguage memoization", () => {
  afterEach(() => clearLanguageCache());

  test("returns the same reference for repeated calls on the same dir (cache hit)", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "x", devDependencies: { typescript: "^5" } }));
      const a = await detectLanguage(dir);
      const b = await detectLanguage(dir);
      // Same value
      expect(b).toEqual(a);
      // Same reference — proves the second call did NOT re-run detection
      expect(b).toBe(a);
    });
  });

  test("calls the underlying filesystem accessor only once per dir", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "x", devDependencies: { typescript: "^5" } }));

      let readCount = 0;
      const originalReadJson = _detectorDeps.readJson;
      _detectorDeps.readJson = async (path) => {
        readCount++;
        return originalReadJson(path);
      };
      try {
        await detectLanguage(dir);
        await detectLanguage(dir);
        expect(readCount).toBe(1);
      } finally {
        _detectorDeps.readJson = originalReadJson;
      }
    });
  });

  test("different directories get independent cache entries", async () => {
    await withTempDir(async (dir1) => {
      await withTempDir(async (dir2) => {
        await Bun.write(`${dir1}/package.json`, JSON.stringify({ name: "a", devDependencies: { typescript: "^5" } }));
        await Bun.write(`${dir2}/go.mod`, "module example.com/b\n");
        const lang1 = await detectLanguage(dir1);
        const lang2 = await detectLanguage(dir2);
        expect(lang1).toBe("typescript");
        expect(lang2).toBe("go");
      });
    });
  });

  test("clearLanguageCache resets memo so next call re-detects", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/package.json`, JSON.stringify({ name: "x", devDependencies: { typescript: "^5" } }));
      const a = await detectLanguage(dir);

      clearLanguageCache();

      let readCount = 0;
      const originalReadJson = _detectorDeps.readJson;
      _detectorDeps.readJson = async (path) => {
        readCount++;
        return originalReadJson(path);
      };
      try {
        const b = await detectLanguage(dir);
        expect(readCount).toBe(1); // re-ran detection after cache clear
        expect(b).toEqual(a);
      } finally {
        _detectorDeps.readJson = originalReadJson;
      }
    });
  });
});
