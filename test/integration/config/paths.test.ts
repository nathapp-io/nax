// RE-ARCH: keep
/**
 * Config Paths Test Suite
 *
 * Tests for path resolution utilities.
 */

import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { featureDir, globalConfigDir, projectConfigDir } from "../../../src/config/paths";

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

  describe("featureDir (SEC-3: featureId validation)", () => {
    const root = "/path/to/project";

    test("returns <root>/.nax/features/<featureId> for a normal slug", () => {
      expect(featureDir(root, "auth-system")).toBe(join(root, ".nax", "features", "auth-system"));
    });

    test("allows the '_unattached' internal sentinel (leading underscore)", () => {
      expect(featureDir(root, "_unattached")).toBe(join(root, ".nax", "features", "_unattached"));
    });

    test("rejects an empty featureId", () => {
      expect(() => featureDir(root, "")).toThrow("Feature ID cannot be empty");
    });

    test("rejects path traversal", () => {
      expect(() => featureDir(root, "../../etc/passwd")).toThrow("path traversal");
    });

    test("rejects a featureId shaped like a git flag", () => {
      expect(() => featureDir(root, "--upload-pack=evil")).toThrow("git flags");
    });

    test("rejects a featureId with invalid characters", () => {
      expect(() => featureDir(root, "has spaces")).toThrow("must match pattern");
    });

    test("rejects a featureId over 64 characters", () => {
      expect(() => featureDir(root, "a".repeat(65))).toThrow("must match pattern");
    });
  });
});
