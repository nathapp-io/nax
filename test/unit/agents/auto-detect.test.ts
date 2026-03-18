// RE-ARCH: keep
/**
 * Tests for context auto-detection (BUG-006)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { autoDetectContextFiles, extractKeywords } from "../../../src/context/auto-detect";

describe("Context Auto-Detection", () => {
  describe("extractKeywords", () => {
    test("should extract keywords from simple title", () => {
      const keywords = extractKeywords("BUG-006: Context auto-detection");
      expect(keywords).toContain("006");
      expect(keywords).toContain("context");
      expect(keywords).toContain("auto");
      expect(keywords).toContain("detection");
    });

    test("should remove common stop words", () => {
      const keywords = extractKeywords("Add the new feature for user authentication");
      expect(keywords).not.toContain("the");
      expect(keywords).not.toContain("for");
      expect(keywords).not.toContain("add");
      expect(keywords).toContain("new");
      expect(keywords).toContain("feature");
      expect(keywords).toContain("user");
      expect(keywords).toContain("authentication");
    });

    test("should handle punctuation and special chars", () => {
      const keywords = extractKeywords("Fix: API endpoint (v2) - rate-limiting");
      expect(keywords).toContain("api");
      expect(keywords).toContain("endpoint");
      expect(keywords).toContain("rate");
      expect(keywords).toContain("limiting");
    });

    test("should deduplicate keywords", () => {
      const keywords = extractKeywords("Context context CONTEXT");
      expect(keywords.filter((k) => k === "context")).toHaveLength(1);
    });

    test("should filter short words (< 3 chars)", () => {
      const keywords = extractKeywords("Fix a bug in UI");
      expect(keywords).not.toContain("in");
      expect(keywords).not.toContain("ui"); // length 2
    });

    test("should return empty array for title with only stop words", () => {
      const keywords = extractKeywords("The and or to");
      expect(keywords).toHaveLength(0);
    });

    test("should lowercase all keywords", () => {
      const keywords = extractKeywords("UPPERCASE lowercase MixedCase");
      expect(keywords).toContain("uppercase");
      expect(keywords).toContain("lowercase");
      expect(keywords).toContain("mixedcase");
      expect(keywords).not.toContain("UPPERCASE");
      expect(keywords).not.toContain("MixedCase");
    });
  });

  describe("autoDetectContextFiles", () => {
    let tempDir: string;

    beforeEach(async () => {
      // Create temp git repo
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-autodetect-test-"));
      await Bun.spawn(["git", "init"], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "config", "user.email", "test@test.com"], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "config", "user.name", "Test User"], { cwd: tempDir }).exited;
    });

    afterEach(async () => {
      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test("should detect files matching keywords", async () => {
      // Create test files
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/context-builder.ts"), "export function buildContext() {}");
      await fs.writeFile(path.join(tempDir, "src/auto-detect.ts"), "export function autoDetectContextFiles() {}");
      await fs.writeFile(path.join(tempDir, "src/unrelated.ts"), "export function foo() {}");

      // Commit files so git grep can find them
      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "BUG-006: Context auto-detection",
        maxFiles: 5,
      });

      expect(files).toContain("src/context-builder.ts");
      expect(files).toContain("src/auto-detect.ts");
      expect(files).not.toContain("src/unrelated.ts");
    });

    test("should exclude test files", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "test"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/context.ts"), "export function buildContext() {}");
      await fs.writeFile(path.join(tempDir, "test/context.test.ts"), "test('context', () => {})");

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "Context builder",
        maxFiles: 5,
      });

      expect(files).toContain("src/context.ts");
      expect(files).not.toContain("test/context.test.ts");
    });

    test("should exclude index files", async () => {
      await fs.mkdir(path.join(tempDir, "src/context"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/context/index.ts"), "export * from './builder'");
      await fs.writeFile(path.join(tempDir, "src/context/builder.ts"), "export function buildContext() {}");

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "Context builder",
        maxFiles: 5,
      });

      expect(files).toContain("src/context/builder.ts");
      expect(files).not.toContain("src/context/index.ts");
    });

    test("should respect maxFiles limit", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      for (let i = 1; i <= 10; i++) {
        await fs.writeFile(path.join(tempDir, `src/file${i}.ts`), `// Contains keyword: routing`);
      }

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "Routing system",
        maxFiles: 3,
      });

      expect(files.length).toBeLessThanOrEqual(3);
    });

    test("should return empty array when no matches", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/unrelated.ts"), "export function foo() {}");

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "NonExistentKeyword XYZ123",
        maxFiles: 5,
      });

      expect(files).toHaveLength(0);
    });

    test("should return empty array when no keywords extracted", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/file.ts"), "export function test() {}");

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "the and or", // All stop words
        maxFiles: 5,
      });

      expect(files).toHaveLength(0);
    });

    test("should handle non-git directory gracefully", async () => {
      // Create non-git temp dir
      const nonGitDir = await fs.mkdtemp(path.join(os.tmpdir(), "nax-nongit-"));
      await fs.mkdir(path.join(nonGitDir, "src"), { recursive: true });
      await fs.writeFile(path.join(nonGitDir, "src/file.ts"), "export function test() {}");

      const files = await autoDetectContextFiles({
        workdir: nonGitDir,
        storyTitle: "Test story",
        maxFiles: 5,
      });

      expect(files).toHaveLength(0);

      // Clean up
      await fs.rm(nonGitDir, { recursive: true, force: true });
    });

    test("should sort files by relevance score", async () => {
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      // File with 2 keyword matches
      await fs.writeFile(path.join(tempDir, "src/context-builder.ts"), "context builder code");
      // File with 1 keyword match
      await fs.writeFile(path.join(tempDir, "src/context-helper.ts"), "context helper code");
      // File with 1 keyword match
      await fs.writeFile(path.join(tempDir, "src/builder-utils.ts"), "builder utils code");

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "Context builder system",
        maxFiles: 5,
      });

      // File with most keyword matches should be first
      expect(files[0]).toBe("src/context-builder.ts");
    });

    test("should exclude generated files", async () => {
      await fs.mkdir(path.join(tempDir, "src/__generated__"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/__generated__/schema.ts"), "// generated schema");
      await fs.writeFile(path.join(tempDir, "src/schema.ts"), "export const schema = {}");

      await Bun.spawn(["git", "add", "."], { cwd: tempDir }).exited;
      await Bun.spawn(["git", "commit", "-m", "initial"], { cwd: tempDir }).exited;

      const files = await autoDetectContextFiles({
        workdir: tempDir,
        storyTitle: "Schema validation",
        maxFiles: 5,
      });

      expect(files).toContain("src/schema.ts");
      expect(files).not.toContain("src/__generated__/schema.ts");
    });
  });
});
