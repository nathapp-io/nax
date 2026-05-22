/**
 * Unit tests for `nax prompts --init` command (PE-001)
 *
 * Tests the promptsInitCommand function which exports default role-body
 * templates to nax/templates/ directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _promptsInitDeps, promptsInitCommand } from "../../../src/cli/prompts";
import { buildRoleTaskSection } from "../../../src/prompts/sections/role-task";
import { makeTempDir } from "../../helpers/temp";


const TEMPLATE_FILES = [
  "test-writer.md",
  "implementer.md",
  "verifier.md",
  "single-session.md",
  "tdd-simple.md",
] as const;

const ROLE_SECTION_ARGS: Record<(typeof TEMPLATE_FILES)[number], Parameters<typeof buildRoleTaskSection>> = {
  "test-writer.md": ["test-writer"],
  "implementer.md": ["implementer", "standard"],
  "verifier.md": ["verifier"],
  "single-session.md": ["single-session"],
  "tdd-simple.md": ["tdd-simple"],
};

describe("promptsInitCommand — directory creation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates nax/templates/ when it does not exist; succeeds when it already exists", async () => {
    await promptsInitCommand({ workdir: tempDir });
    expect(existsSync(join(tempDir, ".nax", "templates"))).toBe(true);

    await promptsInitCommand({ workdir: tempDir });
  });
});

describe("promptsInitCommand — per-file checks (exists, content, header)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes exactly 5 template files", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const templatesDir = join(tempDir, ".nax", "templates");
    const files = (await import("node:fs")).readdirSync(templatesDir);
    expect(files.length).toBe(5);
  });

  for (const file of TEMPLATE_FILES) {
    test(`${file}: exists, non-empty, contains role section, has header comment with controls/non-overridable mentions`, async () => {
      await promptsInitCommand({ workdir: tempDir });

      const filePath = join(tempDir, ".nax", "templates", file);
      expect(existsSync(filePath), `${file} exists`).toBe(true);

      const content = await Bun.file(filePath).text();
      expect(content.length, `${file} non-empty`).toBeGreaterThan(0);

      const expected = buildRoleTaskSection(...ROLE_SECTION_ARGS[file]);
      expect(content, `${file} role section`).toContain(expected);

      expect(content, `${file} header comment`).toMatch(/<!--[\s\S]+?-->/);
      expect(content.toLowerCase(), `${file} mentions override/controls`).toMatch(/override|role.?body|controls|customize/);

      const mentionsNonOverridable =
        content.toLowerCase().includes("isolation") ||
        content.toLowerCase().includes("story context") ||
        content.toLowerCase().includes("conventions") ||
        content.toLowerCase().includes("non-overridable") ||
        content.toLowerCase().includes("cannot be overridden");
      expect(mentionsNonOverridable, `${file} non-overridable mention`).toBe(true);
    });
  }
});

describe("promptsInitCommand — no-overwrite protection", () => {
  let tempDir: string;
  let consoleOutput: string[];
  let savedLog: typeof _promptsInitDeps.log;
  let savedWarn: typeof _promptsInitDeps.warn;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir, ".nax", "templates"), { recursive: true });

    consoleOutput = [];
    savedLog = _promptsInitDeps.log;
    savedWarn = _promptsInitDeps.warn;
    _promptsInitDeps.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    _promptsInitDeps.warn = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    _promptsInitDeps.log = savedLog;
    _promptsInitDeps.warn = savedWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prints warning and does NOT overwrite single existing file without --force", async () => {
    const existingContent = "existing user customization — do not overwrite";
    writeFileSync(join(tempDir, ".nax", "templates", "test-writer.md"), existingContent);

    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput.toLowerCase()).toMatch(/warn|already exist|skip|no.*overwrite/);
    expect(await Bun.file(join(tempDir, ".nax", "templates", "test-writer.md")).text()).toBe(existingContent);
  });

  test("does NOT overwrite any existing files when multiple exist; exits without writing new files", async () => {
    const originalContents: Record<string, string> = {};
    for (const file of TEMPLATE_FILES) {
      const content = `original content for ${file}`;
      writeFileSync(join(tempDir, ".nax", "templates", file), content);
      originalContents[file] = content;
    }

    await promptsInitCommand({ workdir: tempDir });

    for (const file of TEMPLATE_FILES) {
      expect(await Bun.file(join(tempDir, ".nax", "templates", file)).text(), file).toBe(originalContents[file]);
    }

    // When only implementer.md exists, others should NOT be created
    const tempDir2 = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir2, ".nax", "templates"), { recursive: true });
    writeFileSync(join(tempDir2, ".nax", "templates", "implementer.md"), "existing content");
    await promptsInitCommand({ workdir: tempDir2 });
    expect(existsSync(join(tempDir2, ".nax", "templates", "test-writer.md"))).toBe(false);
    expect(existsSync(join(tempDir2, ".nax", "templates", "verifier.md"))).toBe(false);
    rmSync(tempDir2, { recursive: true, force: true });
  });
});

describe("promptsInitCommand — --force flag", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir, ".nax", "templates"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("overwrites existing files when force=true; writes all 5 files even if all exist", async () => {
    const oldContent = "old content to be replaced";
    writeFileSync(join(tempDir, ".nax", "templates", "test-writer.md"), oldContent);

    await promptsInitCommand({ workdir: tempDir, force: true });

    const content = await Bun.file(join(tempDir, ".nax", "templates", "test-writer.md")).text();
    expect(content).not.toBe(oldContent);
    expect(content).toContain(buildRoleTaskSection("test-writer"));

    for (const file of TEMPLATE_FILES) {
      writeFileSync(join(tempDir, ".nax", "templates", file), "old content");
    }
    await promptsInitCommand({ workdir: tempDir, force: true });
    for (const file of TEMPLATE_FILES) {
      expect(await Bun.file(join(tempDir, ".nax", "templates", file)).text(), file).not.toBe("old content");
    }
  });
});

describe("promptsInitCommand — summary output", () => {
  let tempDir: string;
  let consoleOutput: string[];
  let savedLog: typeof _promptsInitDeps.log;
  let savedWarn: typeof _promptsInitDeps.warn;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    consoleOutput = [];
    savedLog = _promptsInitDeps.log;
    savedWarn = _promptsInitDeps.warn;
    _promptsInitDeps.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    _promptsInitDeps.warn = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    _promptsInitDeps.log = savedLog;
    _promptsInitDeps.warn = savedWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("prints names of files written and activation instructions after success", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("test-writer.md");
    expect(allOutput).toContain("implementer.md");
    expect(allOutput).toContain("verifier.md");
    expect(allOutput).toContain("single-session.md");
    expect(allOutput).toContain("tdd-simple.md");

    const lower = allOutput.toLowerCase();
    const mentionsActivation =
      lower.includes("override") ||
      lower.includes("config") ||
      lower.includes("prompts.overrides") ||
      lower.includes("activate");
    expect(mentionsActivation).toBe(true);
  });
});

describe("promptsInitCommand — return value", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-init-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns list of 5 file paths within nax/templates/ on success; empty array when files exist and no --force", async () => {
    const result = await promptsInitCommand({ workdir: tempDir });
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(5);
    for (const filePath of result) {
      expect(filePath).toContain("templates");
    }

    mkdirSync(join(tempDir, ".nax", "templates"), { recursive: true });
    writeFileSync(join(tempDir, ".nax", "templates", "test-writer.md"), "existing");
    expect(await promptsInitCommand({ workdir: tempDir })).toEqual([]);
  });
});
