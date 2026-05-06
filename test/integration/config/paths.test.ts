// RE-ARCH: keep
/**
 * Config Paths Test Suite
 *
 * Tests for path resolution utilities.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { globalConfigDir, projectConfigDir } from "../../../src/config/paths";

describe("config/paths", () => {
  describe("globalConfigDir", () => {
    test("returns override when NAX_GLOBAL_CONFIG_DIR is set", () => {
      expect(globalConfigDir()).toBe(process.env.NAX_GLOBAL_CONFIG_DIR);
    });

    test("returns ~/.nax directory when override is absent", () => {
      const original = process.env.NAX_GLOBAL_CONFIG_DIR;
      delete process.env.NAX_GLOBAL_CONFIG_DIR;

      const expected = join(homedir(), ".nax");
      expect(globalConfigDir()).toBe(expected);

      process.env.NAX_GLOBAL_CONFIG_DIR = original;
    });

    test("returns absolute path", () => {
      const result = globalConfigDir();
      expect(result.startsWith("/")).toBe(true);
    });
  });

  describe("projectConfigDir", () => {
    test("returns nax directory when given project root", () => {
      const projectRoot = "/path/to/project";
      const expected = join(projectRoot, ".nax");
      expect(projectConfigDir(projectRoot)).toBe(expected);
    });

    test("normalizes path separators", () => {
      const projectRoot = "/path/to/project";
      const result = projectConfigDir(projectRoot);
      expect(result).toBe("/path/to/project/.nax");
    });

    test("handles paths with trailing slash", () => {
      const projectRoot = "/path/to/project/";
      const expected = "/path/to/project/.nax";
      expect(projectConfigDir(projectRoot)).toBe(expected);
    });

    test("resolves relative paths to absolute", () => {
      const projectRoot = "./project";
      const result = projectConfigDir(projectRoot);
      expect(result).toContain("/project/.nax");
      expect(result.startsWith("/")).toBe(true);
    });
  });
});
