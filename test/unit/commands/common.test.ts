// RE-ARCH: keep
/**
 * Tests for src/commands/common.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { resolveProject, resolveProjectAsync } from "@/commands/common";
import { NaxError } from "@/errors";

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
    test("uses explicit absolute directory; checks projectDir and configPath", () => {
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(tmpdir());
      const result = resolveProject({ dir: testDir });
      expect(result.projectDir).toBe(testDir);
      expect(result.configPath).toBe(join(naxDir, "config.json"));
    });

    test("resolves relative paths to absolute", () => {
      const projectDir = join(testDir, "my-project");
      const naxDir = join(projectDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);
      const result = resolveProject({ dir: "./my-project" });
      expect(result.projectDir).toBe(projectDir);
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

    test("throws NaxError with 'Feature not found' and 'No features found' messages when no features directory exists", () => {
      const naxDir = join(testDir, ".nax");
      mkdirSync(naxDir, { recursive: true });
      writeFileSync(join(naxDir, "config.json"), "{}");
      process.chdir(testDir);
      try {
        resolveProject({ feature: "nonexistent" });
        expect.unreachable("Should have thrown error");
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        const message = (err as NaxError).message;
        expect(message).toMatch(/Feature not found: nonexistent/);
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
    test("includes correct error codes and context fields for PROJECT_NOT_FOUND, NAX_DIR_NOT_FOUND, CONFIG_NOT_FOUND, and FEATURE_NOT_FOUND", () => {
      // PROJECT_NOT_FOUND
      const s1 = join(testDir, "s1-empty");
      mkdirSync(s1, { recursive: true });
      process.chdir(s1);
      try {
        resolveProject();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        expect((err as NaxError).code).toBe("PROJECT_NOT_FOUND");
        expect((err as NaxError).context?.cwd).toBe(s1);
      }

      // NAX_DIR_NOT_FOUND
      const s2 = join(testDir, "s2-no-nax");
      mkdirSync(s2, { recursive: true });
      try {
        resolveProject({ dir: s2 });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        expect((err as NaxError).code).toBe("NAX_DIR_NOT_FOUND");
        expect((err as NaxError).context?.projectRoot).toBe(s2);
      }

      // CONFIG_NOT_FOUND
      const s3 = join(testDir, "s3");
      const s3Nax = join(s3, ".nax");
      mkdirSync(s3Nax, { recursive: true });
      process.chdir(s3);
      try {
        resolveProject();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        expect((err as NaxError).code).toBe("CONFIG_NOT_FOUND");
        expect((err as NaxError).context?.configPath).toBe(join(s3Nax, "config.json"));
      }

      // FEATURE_NOT_FOUND
      const s4 = join(testDir, "s4");
      const s4Nax = join(s4, ".nax");
      mkdirSync(join(s4Nax, "features", "existing-feature"), { recursive: true });
      writeFileSync(join(s4Nax, "config.json"), "{}");
      process.chdir(s4);
      try {
        resolveProject({ feature: "nonexistent" });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(NaxError);
        expect((err as NaxError).code).toBe("FEATURE_NOT_FOUND");
        expect((err as NaxError).context?.feature).toBe("nonexistent");
        expect((err as NaxError).context?.availableFeatures).toEqual(["existing-feature"]);
      }
    });
  });
});

describe("resolveProjectAsync", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    const rawTestDir = makeTempDir("nax-test-async-");
    testDir = realpathSync(rawTestDir);
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("resolves by filesystem path (absolute) and path wins over name lookup", async () => {
    const naxDir = join(testDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    const result = await resolveProjectAsync({ dir: testDir });
    expect(result.projectDir).toBe(testDir);

    // path wins over name lookup when path exists as a real dir
    process.chdir(join(testDir, ".."));
    const result2 = await resolveProjectAsync({ dir: testDir });
    expect(result2.projectDir).toBe(testDir);
  });

  test("resolves by project name via identity registry", async () => {
    // Set up real project directory with .nax/config.json
    const projectDir = join(testDir, "my-project");
    const naxDir = join(projectDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    // Set up identity registry entry pointing to it
    // globalConfigDir() is redirected to a temp dir in tests via preload.ts
    const { globalConfigDir } = await import("@/config/paths");
    const registryDir = join(globalConfigDir(), "my-project");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, ".identity"),
      JSON.stringify({ workdir: projectDir, name: "my-project", createdAt: "", lastSeen: "", remoteUrl: null }),
    );

    const result = await resolveProjectAsync({ dir: "my-project" });
    expect(result.projectDir).toBe(projectDir);
  });

  test("throws NaxError for name not in registry, path-with-separator not found, and corrupt identity", async () => {
    // name not in registry
    process.chdir(testDir);
    try {
      await resolveProjectAsync({ dir: "nonexistent-project" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("PROJECT_NOT_FOUND");
      expect(e.message).toContain("nonexistent-project");
      expect(e.message).toContain("identity registry");
    }

    // path with separators that don't exist
    try {
      await resolveProjectAsync({ dir: "some/nonexistent/path" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect(["NAX_DIR_NOT_FOUND", "PROJECT_NOT_FOUND"]).toContain((err as NaxError).code);
    }

    // corrupt identity file
    const { globalConfigDir } = await import("@/config/paths");
    const registryDir = join(globalConfigDir(), "corrupt-project");
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, ".identity"), "not valid json{{{");
    try {
      await resolveProjectAsync({ dir: "corrupt-project" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      expect((err as NaxError).code).toBe("PROJECT_NOT_FOUND");
    }
  });

  test("falls back to CWD walk-up when no dir provided", async () => {
    const naxDir = join(testDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");
    process.chdir(testDir);

    const result = await resolveProjectAsync();
    expect(result.projectDir).toBe(testDir);
  });
});
