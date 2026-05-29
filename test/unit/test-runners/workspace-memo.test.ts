/**
 * Unit tests for discoverWorkspacePackages memoization (B1).
 *
 * Verifies that calling discoverWorkspacePackages twice on the same directory
 * returns the same cached reference (no second filesystem read).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  clearWorkspaceCache,
  discoverWorkspacePackages,
  _workspaceDeps,
} from "../../../src/test-runners/detect/workspace";
import { withTempDir } from "../../helpers/temp";

describe("discoverWorkspacePackages memoization", () => {
  afterEach(() => clearWorkspaceCache());

  test("returns the same array reference for repeated calls on the same dir (cache hit)", async () => {
    await withTempDir(async (dir) => {
      const a = await discoverWorkspacePackages(dir);
      const b = await discoverWorkspacePackages(dir);
      // Same reference — proves second call served from cache
      expect(b).toBe(a);
    });
  });

  test("calls the underlying readText only once per dir", async () => {
    await withTempDir(async (dir) => {
      let readCount = 0;
      const originalReadText = _workspaceDeps.readText;
      _workspaceDeps.readText = async (path) => {
        readCount++;
        return originalReadText(path);
      };
      try {
        await discoverWorkspacePackages(dir);
        const countAfterFirst = readCount;
        await discoverWorkspacePackages(dir);
        // No additional reads on second call
        expect(readCount).toBe(countAfterFirst);
      } finally {
        _workspaceDeps.readText = originalReadText;
      }
    });
  });

  test("different directories get independent cache entries", async () => {
    await withTempDir(async (dir1) => {
      await withTempDir(async (dir2) => {
        const a = await discoverWorkspacePackages(dir1);
        const b = await discoverWorkspacePackages(dir2);
        // Both are arrays, independent references
        expect(Array.isArray(a)).toBe(true);
        expect(Array.isArray(b)).toBe(true);
        // Second call on each still returns the cached reference
        expect(await discoverWorkspacePackages(dir1)).toBe(a);
        expect(await discoverWorkspacePackages(dir2)).toBe(b);
      });
    });
  });

  test("clearWorkspaceCache resets memo so next call re-runs detection", async () => {
    await withTempDir(async (dir) => {
      const a = await discoverWorkspacePackages(dir);

      clearWorkspaceCache();

      let readCount = 0;
      const originalReadText = _workspaceDeps.readText;
      _workspaceDeps.readText = async (path) => {
        readCount++;
        return originalReadText(path);
      };
      try {
        const b = await discoverWorkspacePackages(dir);
        expect(readCount).toBeGreaterThan(0); // re-ran detection after cache clear
        expect(b).toEqual(a);
      } finally {
        _workspaceDeps.readText = originalReadText;
      }
    });
  });
});
