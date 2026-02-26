import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateDirectory, validateFilePath, isWithinDirectory, MAX_DIRECTORY_DEPTH } from "../../src/config";
import { findProjectDir } from "../../src/config/loader";

// Create a temporary test directory
const testRoot = join(tmpdir(), `nax-path-test-${Date.now()}`);
let testProject = join(testRoot, "project");
let testOutside = join(testRoot, "outside");

beforeAll(() => {
  // Create test directory structure
  mkdirSync(testProject, { recursive: true });
  mkdirSync(join(testProject, "src"), { recursive: true });
  mkdirSync(join(testProject, "nax"), { recursive: true });
  writeFileSync(join(testProject, "nax", "config.json"), "{}");
  mkdirSync(testOutside, { recursive: true });

  // Resolve real paths (handles macOS /private prefix)
  testProject = realpathSync(testProject);
  testOutside = realpathSync(testOutside);

  // Create a deep directory structure for max depth testing
  let deepPath = join(testProject, "deep");
  for (let i = 0; i < 15; i++) {
    deepPath = join(deepPath, `level${i}`);
    mkdirSync(deepPath, { recursive: true });
  }

  // Create symlink to outside directory
  const symlinkPath = join(testProject, "link-to-outside");
  if (!existsSync(symlinkPath)) {
    symlinkSync(testOutside, symlinkPath, "dir");
  }
});

afterAll(() => {
  // Clean up test directories
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Path Security", () => {
  describe("validateDirectory", () => {
    test("accepts valid directory", () => {
      const result = validateDirectory(testProject);
      expect(result).toBe(testProject);
    });

    test("rejects non-existent directory", () => {
      expect(() => {
        validateDirectory(join(testProject, "nonexistent"));
      }).toThrow("Directory does not exist");
    });

    test("rejects file path (not a directory)", () => {
      const filePath = join(testProject, "nax", "config.json");
      expect(() => {
        validateDirectory(filePath);
      }).toThrow("Not a directory");
    });

    test("resolves relative paths", () => {
      const cwd = process.cwd();
      process.chdir(testProject);
      const result = validateDirectory(".");
      process.chdir(cwd);
      expect(result).toBe(testProject);
    });

    test("rejects path outside base directory", () => {
      expect(() => {
        validateDirectory(testOutside, testProject);
      }).toThrow("Path is outside allowed directory");
    });

    test("accepts path inside base directory", () => {
      const srcDir = join(testProject, "src");
      const result = validateDirectory(srcDir, testProject);
      expect(result).toBe(srcDir);
    });

    test("detects symlink traversal outside base", () => {
      const symlinkPath = join(testProject, "link-to-outside");
      expect(() => {
        validateDirectory(symlinkPath, testProject);
      }).toThrow("Path is outside allowed directory");
    });
  });

  describe("validateFilePath", () => {
    test("accepts file within base directory", () => {
      const filePath = join(testProject, "nax", "config.json");
      const result = validateFilePath(filePath, testProject);
      expect(result).toBe(filePath);
    });

    test("rejects file outside base directory", () => {
      const outsideFile = join(testOutside, "file.txt");
      writeFileSync(outsideFile, "test");
      expect(() => {
        validateFilePath(outsideFile, testProject);
      }).toThrow("Path is outside allowed directory");
    });

    test("accepts non-existent file within base directory", () => {
      const newFile = join(testProject, "newfile.txt");
      const result = validateFilePath(newFile, testProject);
      expect(result).toContain("newfile.txt");
    });
  });

  describe("isWithinDirectory", () => {
    test("returns true for path within directory", () => {
      expect(isWithinDirectory(join(testProject, "src"), testProject)).toBe(true);
    });

    test("returns true for same directory", () => {
      expect(isWithinDirectory(testProject, testProject)).toBe(true);
    });

    test("returns false for path outside directory", () => {
      expect(isWithinDirectory(testOutside, testProject)).toBe(false);
    });

    test("returns false for parent directory", () => {
      expect(isWithinDirectory(testRoot, testProject)).toBe(false);
    });

    test("prevents partial path matches", () => {
      const similar = join(testRoot, "project-other");
      mkdirSync(similar, { recursive: true });
      expect(isWithinDirectory(similar, testProject)).toBe(false);
    });

    test("returns false for relative paths", () => {
      expect(isWithinDirectory("./src", testProject)).toBe(false);
    });
  });

  describe("findProjectDir max depth", () => {
    test("respects MAX_DIRECTORY_DEPTH limit", () => {
      // Start from very deep directory (15 levels)
      let deepPath = join(testProject, "deep");
      for (let i = 0; i < 15; i++) {
        deepPath = join(deepPath, `level${i}`);
      }

      // Should not find the nax directory because it's > 10 levels up
      const result = findProjectDir(deepPath);
      expect(result).toBeNull();
    });

    test("finds project within MAX_DIRECTORY_DEPTH", () => {
      // Start from 5 levels deep
      let deepPath = join(testProject, "deep");
      for (let i = 0; i < 5; i++) {
        deepPath = join(deepPath, `level${i}`);
      }

      // Should find the nax directory (5 levels up < 10 max)
      const result = findProjectDir(deepPath);
      expect(result).toBe(join(testProject, "nax"));
    });

    test("MAX_DIRECTORY_DEPTH is reasonable (10)", () => {
      expect(MAX_DIRECTORY_DEPTH).toBe(10);
    });
  });
});
