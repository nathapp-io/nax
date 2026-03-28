// RE-ARCH: keep
/**
 * Tests for src/commands/common.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../../../src/commands/common";
import { NaxError } from "../../../src/errors";
import { makeTempDir } from "../../helpers/temp";

describe("resolveProject", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    // Create temp directory for test (resolve symlinks for consistent paths)
    const rawTestDir = makeTempDir("nax-test-");
    testDir = realpathSync(rawTestDir);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    // Restore original CWD
    process.chdir(originalCwd);

    // Clean up test directory
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("CWD resolution", () => {
    test("returns projectDir when CWD has nax/ directory", () => {
      // Setup: Create nax/config.json in test directory
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Change to test directory
      process.chdir(testDir);

      // Act
      const result = resolveProject();

      // Assert
      expect(result.projectDir).toBe(testDir);
      expect(result.configPath).toBe(join(naxDir, "config.json"));
      expect(result.featureDir).toBeUndefined();
    });

    test("walks up directory tree to find nax/ directory", () => {
      // Setup: Create nax/config.json in parent directory
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Create subdirectory and change to it
      const subDir = join(testDir, "src", "nested");
      mkdirSync(subDir, { recursive: true });
      process.chdir(subDir);

      // Act
      const result = resolveProject();

      // Assert
      expect(result.projectDir).toBe(testDir);
      expect(result.configPath).toBe(join(naxDir, "config.json"));
    });

    test("throws error when no nax/ directory found", () => {
      // Setup: Create directory without nax/
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir, { recursive: true });
      process.chdir(emptyDir);

      // Act & Assert
      expect(() => resolveProject()).toThrow(NaxError);
      expect(() => resolveProject()).toThrow(/No nax project found/);
    });
  });

  describe("explicit directory (-d flag)", () => {
    test("uses explicit directory when provided", () => {
      // Setup: Create nax/config.json in test directory
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Change to different directory
      process.chdir(tmpdir());

      // Act
      const result = resolveProject({ dir: testDir });

      // Assert
      expect(result.projectDir).toBe(testDir);
      expect(result.configPath).toBe(join(naxDir, "config.json"));
    });

    test("resolves relative paths to absolute", () => {
      // Setup: Create nax/config.json in test directory
      const projectDir = join(testDir, "my-project");
      const naxDir = join(projectDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Change to parent directory
      process.chdir(testDir);

      // Act: Use relative path
      const result = resolveProject({ dir: "./my-project" });

      // Assert: Returns absolute path
      expect(result.projectDir).toBe(projectDir);
    });

    test("handles absolute paths", () => {
      // Setup: Create nax/config.json in test directory
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Act: Use absolute path
      const result = resolveProject({ dir: testDir });

      // Assert
      expect(result.projectDir).toBe(testDir);
    });

    test("throws error when explicit directory has no nax/", () => {
      // Setup: Create directory without nax/
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir, { recursive: true });

      // Act & Assert
      expect(() => resolveProject({ dir: emptyDir })).toThrow(NaxError);
      expect(() => resolveProject({ dir: emptyDir })).toThrow(/does not contain a nax project/);
    });
  });

  describe("validation", () => {
    test("throws error when nax/config.json does not exist", () => {
      // Setup: Create nax/ but no config.json
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      process.chdir(testDir);

      // Act & Assert
      expect(() => resolveProject()).toThrow(NaxError);
      expect(() => resolveProject()).toThrow(/config.json is missing/);
    });
  });

  describe("feature validation", () => {
    test("returns featureDir when feature exists", () => {
      // Setup: Create nax/features/my-feature/
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      const featureDir = join(featuresDir, "my-feature");
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);

      // Act
      const result = resolveProject({ feature: "my-feature" });

      // Assert
      expect(result.featureDir).toBe(featureDir);
    });

    test("throws error when feature does not exist", () => {
      // Setup: Create nax/ but no features
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);

      // Act & Assert
      expect(() => resolveProject({ feature: "nonexistent" })).toThrow(NaxError);
      expect(() => resolveProject({ feature: "nonexistent" })).toThrow(/Feature not found: nonexistent/);
    });

    test("lists available features when feature not found", () => {
      // Setup: Create nax/features with multiple features
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(join(featuresDir, "feature-a"), { recursive: true });
      mkdirSync(join(featuresDir, "feature-b"), { recursive: true });
      mkdirSync(join(featuresDir, "feature-c"), { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);

      // Act & Assert
      try {
        resolveProject({ feature: "nonexistent" });
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const message = (err as NaxError).message;
        expect(message).toContain("Available features:");
        expect(message).toContain("feature-a");
        expect(message).toContain("feature-b");
        expect(message).toContain("feature-c");
      }
    });

    test("shows helpful message when no features exist", () => {
      // Setup: Create nax/ but no features directory
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);

      // Act & Assert
      try {
        resolveProject({ feature: "my-feature" });
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const message = (err as NaxError).message;
        expect(message).toContain("No features found in this project");
      }
    });

    test("validates feature with explicit directory", () => {
      // Setup: Create project with feature
      const projectDir = join(testDir, "project");
      const naxDir = join(projectDir, ".nax");
      const featuresDir = join(naxDir, "features");
      const featureDir = join(featuresDir, "auth");
      mkdirSync(featureDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");

      // Act
      const result = resolveProject({ dir: projectDir, feature: "auth" });

      // Assert
      expect(result.projectDir).toBe(projectDir);
      expect(result.featureDir).toBe(featureDir);
    });
  });

  describe("error context", () => {
    test("includes helpful context in PROJECT_NOT_FOUND error", () => {
      // Setup: Empty directory
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir, { recursive: true });
      process.chdir(emptyDir);

      // Act & Assert
      try {
        resolveProject();
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const naxError = err as NaxError;
        expect(naxError.code).toBe("PROJECT_NOT_FOUND");
        expect(naxError.context?.cwd).toBe(emptyDir);
      }
    });

    test("includes helpful context in NAX_DIR_NOT_FOUND error", () => {
      // Setup: Directory without nax/
      const emptyDir = join(testDir, "empty");
      mkdirSync(emptyDir, { recursive: true });

      // Act & Assert
      try {
        resolveProject({ dir: emptyDir });
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const naxError = err as NaxError;
        expect(naxError.code).toBe("NAX_DIR_NOT_FOUND");
        expect(naxError.context?.projectRoot).toBe(emptyDir);
      }
    });

    test("includes helpful context in CONFIG_NOT_FOUND error", () => {
      // Setup: nax/ without config.json
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      process.chdir(testDir);

      // Act & Assert
      try {
        resolveProject();
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const naxError = err as NaxError;
        expect(naxError.code).toBe("CONFIG_NOT_FOUND");
        expect(naxError.context?.configPath).toBe(join(naxDir, "config.json"));
      }
    });

    test("includes helpful context in FEATURE_NOT_FOUND error", () => {
      // Setup: Project with features
      const naxDir = join(testDir, ".nax");
      const featuresDir = join(naxDir, "features");
      mkdirSync(join(featuresDir, "existing-feature"), { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);

      // Act & Assert
      try {
        resolveProject({ feature: "nonexistent" });
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const naxError = err as NaxError;
        expect(naxError.code).toBe("FEATURE_NOT_FOUND");
        expect(naxError.context?.feature).toBe("nonexistent");
        expect(naxError.context?.availableFeatures).toEqual(["existing-feature"]);
      }
    });
  });
});
