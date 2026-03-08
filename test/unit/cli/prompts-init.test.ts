/**
 * Unit tests for `nax prompts --init` command (PE-001)
 *
 * Tests the promptsInitCommand function which exports default role-body
 * templates to nax/templates/ directory.
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptsInitCommand } from "../../../src/cli/prompts";
import { buildRoleTaskSection } from "../../../src/prompts/sections/role-task";

const TEMPLATE_FILES = [
  "test-writer.md",
  "implementer.md",
  "verifier.md",
  "single-session.md",
] as const;

describe("promptsInitCommand — directory creation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    // Create nax/ directory (required by nax project structure)
    mkdirSync(join(tempDir, "nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates nax/templates/ directory when it does not exist", async () => {
    await promptsInitCommand({ workdir: tempDir });

    expect(existsSync(join(tempDir, "nax", "templates"))).toBe(true);
  });

  test("succeeds when nax/templates/ already exists but is empty", async () => {
    mkdirSync(join(tempDir, "nax", "templates"), { recursive: true });

    await promptsInitCommand({ workdir: tempDir });
  });
});

describe("promptsInitCommand — writes 4 template files", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  for (const file of TEMPLATE_FILES) {
    test(`writes ${file}`, async () => {
      await promptsInitCommand({ workdir: tempDir });

      expect(existsSync(join(tempDir, "nax", "templates", file))).toBe(true);
    });
  }

  test("writes exactly 4 template files", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const templatesDir = join(tempDir, "nax", "templates");
    const files = (await import("node:fs")).readdirSync(templatesDir);
    expect(files.length).toBe(4);
  });
});

describe("promptsInitCommand — template file content", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("test-writer.md contains buildRoleTaskSection('test-writer') output", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const content = await Bun.file(join(tempDir, "nax", "templates", "test-writer.md")).text();
    const expected = buildRoleTaskSection("test-writer");
    expect(content).toContain(expected);
  });

  test("implementer.md contains buildRoleTaskSection('implementer', 'standard') output", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const content = await Bun.file(join(tempDir, "nax", "templates", "implementer.md")).text();
    const expected = buildRoleTaskSection("implementer", "standard");
    expect(content).toContain(expected);
  });

  test("verifier.md contains buildRoleTaskSection('verifier') output", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const content = await Bun.file(join(tempDir, "nax", "templates", "verifier.md")).text();
    const expected = buildRoleTaskSection("verifier");
    expect(content).toContain(expected);
  });

  test("single-session.md contains buildRoleTaskSection('single-session') output", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const content = await Bun.file(join(tempDir, "nax", "templates", "single-session.md")).text();
    const expected = buildRoleTaskSection("single-session");
    expect(content).toContain(expected);
  });

  test("each template file is non-empty", async () => {
    await promptsInitCommand({ workdir: tempDir });

    for (const file of TEMPLATE_FILES) {
      const content = await Bun.file(join(tempDir, "nax", "templates", file)).text();
      expect(content.length).toBeGreaterThan(0);
    }
  });
});

describe("promptsInitCommand — header comment in each template", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  for (const file of TEMPLATE_FILES) {
    test(`${file} contains a header comment`, async () => {
      await promptsInitCommand({ workdir: tempDir });

      const content = await Bun.file(join(tempDir, "nax", "templates", file)).text();
      // Header comment should be at the top (HTML comment or markdown comment)
      expect(content).toMatch(/<!--[\s\S]+?-->/);
    });

    test(`${file} header mentions what the file controls`, async () => {
      await promptsInitCommand({ workdir: tempDir });

      const content = await Bun.file(join(tempDir, "nax", "templates", file)).text();
      // Header should describe what can be overridden
      expect(content.toLowerCase()).toMatch(/override|role.?body|controls|customize/);
    });

    test(`${file} header mentions non-overridable sections`, async () => {
      await promptsInitCommand({ workdir: tempDir });

      const content = await Bun.file(join(tempDir, "nax", "templates", file)).text();
      // At least one of the non-overridable sections must be named
      const mentionsNonOverridable =
        content.toLowerCase().includes("isolation") ||
        content.toLowerCase().includes("story context") ||
        content.toLowerCase().includes("conventions") ||
        content.toLowerCase().includes("non-overridable") ||
        content.toLowerCase().includes("cannot be overridden");
      expect(mentionsNonOverridable).toBe(true);
    });
  }
});

describe("promptsInitCommand — no-overwrite protection", () => {
  let tempDir: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax", "templates"), { recursive: true });

    consoleOutput = [];
    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prints warning when files already exist", async () => {
    // Pre-create one of the template files
    writeFileSync(join(tempDir, "nax", "templates", "test-writer.md"), "existing content");

    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.toLowerCase()).toMatch(/warn|already exist|skip|no.*overwrite/);
  });

  test("does NOT overwrite existing files without --force", async () => {
    const existingContent = "existing user customization — do not overwrite";
    writeFileSync(join(tempDir, "nax", "templates", "test-writer.md"), existingContent);

    await promptsInitCommand({ workdir: tempDir });

    const content = await Bun.file(join(tempDir, "nax", "templates", "test-writer.md")).text();
    expect(content).toBe(existingContent);
  });

  test("does NOT overwrite any existing files without --force when multiple exist", async () => {
    const originalContents: Record<string, string> = {};
    for (const file of TEMPLATE_FILES) {
      const content = `original content for ${file}`;
      writeFileSync(join(tempDir, "nax", "templates", file), content);
      originalContents[file] = content;
    }

    await promptsInitCommand({ workdir: tempDir });

    for (const file of TEMPLATE_FILES) {
      const content = await Bun.file(join(tempDir, "nax", "templates", file)).text();
      expect(content).toBe(originalContents[file]);
    }
  });

  test("exits without writing new files when any template already exists", async () => {
    writeFileSync(join(tempDir, "nax", "templates", "implementer.md"), "existing content");

    await promptsInitCommand({ workdir: tempDir });

    // Other files should NOT have been created
    expect(existsSync(join(tempDir, "nax", "templates", "test-writer.md"))).toBe(false);
    expect(existsSync(join(tempDir, "nax", "templates", "verifier.md"))).toBe(false);
    expect(existsSync(join(tempDir, "nax", "templates", "single-session.md"))).toBe(false);
  });
});

describe("promptsInitCommand — --force flag", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax", "templates"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("overwrites existing files when force=true", async () => {
    const oldContent = "old content to be replaced";
    writeFileSync(join(tempDir, "nax", "templates", "test-writer.md"), oldContent);

    await promptsInitCommand({ workdir: tempDir, force: true });

    const content = await Bun.file(join(tempDir, "nax", "templates", "test-writer.md")).text();
    expect(content).not.toBe(oldContent);
    expect(content).toContain(buildRoleTaskSection("test-writer"));
  });

  test("writes all 4 files when force=true even if all exist", async () => {
    for (const file of TEMPLATE_FILES) {
      writeFileSync(join(tempDir, "nax", "templates", file), "old content");
    }

    await promptsInitCommand({ workdir: tempDir, force: true });

    for (const file of TEMPLATE_FILES) {
      const content = await Bun.file(join(tempDir, "nax", "templates", file)).text();
      expect(content).not.toBe("old content");
    }
  });
});

describe("promptsInitCommand — summary output", () => {
  let tempDir: string;
  let consoleOutput: string[];
  let originalConsoleLog: typeof console.log;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });

    consoleOutput = [];
    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prints names of files written after success", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("test-writer.md");
    expect(allOutput).toContain("implementer.md");
    expect(allOutput).toContain("verifier.md");
    expect(allOutput).toContain("single-session.md");
  });

  test("prints activation instructions after success", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n").toLowerCase();
    // Should tell user how to activate — mention overrides or config
    const mentionsActivation =
      allOutput.includes("override") ||
      allOutput.includes("config") ||
      allOutput.includes("prompts.overrides") ||
      allOutput.includes("activate");
    expect(mentionsActivation).toBe(true);
  });
});

describe("promptsInitCommand — return value", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-init-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns list of files written on success", async () => {
    const result = await promptsInitCommand({ workdir: tempDir });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(4);
  });

  test("returned paths are within nax/templates/", async () => {
    const result = await promptsInitCommand({ workdir: tempDir });

    for (const filePath of result) {
      expect(filePath).toContain("templates");
    }
  });

  test("returns empty array when files exist and no --force", async () => {
    mkdirSync(join(tempDir, "nax", "templates"), { recursive: true });
    writeFileSync(join(tempDir, "nax", "templates", "test-writer.md"), "existing");

    const result = await promptsInitCommand({ workdir: tempDir });

    expect(result).toEqual([]);
  });
});
