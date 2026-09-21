/**
 * Unit tests for `nax prompts --init` command (PE-001)
 *
 * Tests the promptsInitCommand function which exports default role-body
 * templates to nax/templates/ directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeTempDir } from "@test/helpers";
import { _promptsInitDeps, promptsInitCommand } from "@/cli/prompts";
import { applyProtocolRegions, PROTOCOL_REGION_MARKER_PREFIX, unwrapProtocolRegions } from "@/prompts/sections";
import { buildRoleTaskSection } from "@/prompts/sections/role-task";

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

/** Mirrors the source constant in prompts-init.ts — the header injected
 *  above every written template. Used to verify exact file content for AC7,
 *  not merely containment. */
const TEMPLATE_HEADER = `<!--
  This file controls the role-body section of the nax prompt for this role.
  Edit the content below to customize the task instructions given to the agent.

  NON-OVERRIDABLE SECTIONS (always injected by nax, cannot be changed here):
    - Isolation rules (scope, file access boundaries)
    - Story context (acceptance criteria, description, dependencies)
    - Conventions (project coding standards)

  To activate overrides, add to your .nax/config.json:
    { "prompts": { "overrides": { "<role>": ".nax/templates/<role>.md" } } }
-->

`;

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

      const expected = unwrapProtocolRegions(buildRoleTaskSection(...ROLE_SECTION_ARGS[file]));
      // US-005 AC7: the implementer template must equal the header followed by the ACP body,
      // not merely contain it — otherwise extra/misplaced persisted content would pass.
      if (file === "implementer.md") {
        expect(content, `implementer.md equals header + ACP body`).toBe(TEMPLATE_HEADER + expected);
      } else {
        expect(content, `${file} role section`).toContain(expected);
      }

      // US-005 AC6: a written template carries no region marker under either protocol.
      expect(content).not.toContain(PROTOCOL_REGION_MARKER_PREFIX);
      expect(applyProtocolRegions(content, { protocol: "acp" })).toBe(content);
      expect(applyProtocolRegions(content, { protocol: "native" })).toBe(content);

      expect(content, `${file} header comment`).toMatch(/<!--[\s\S]+?-->/);
      expect(content.toLowerCase(), `${file} mentions override/controls`).toMatch(
        /override|role.?body|controls|customize/,
      );

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

/**
 * Unit tests for PE-002: Auto-configure prompts.overrides when templates exist
 *
 * Tests that promptsInitCommand auto-wires prompts.overrides into .nax/config.json
 * after writing template files.
 *
 * BUG-17: the auto-wire previously targeted `.nax/config.json` — a file nothing
 * loads. The config SSOT is `<root>/.nax/config.json` (config/paths.ts), and
 * every fixture here reads/writes that path.
 */

const EXPECTED_OVERRIDES = {
  "test-writer": ".nax/templates/test-writer.md",
  implementer: ".nax/templates/implementer.md",
  verifier: ".nax/templates/verifier.md",
  "single-session": ".nax/templates/single-session.md",
  "tdd-simple": ".nax/templates/tdd-simple.md",
};

function configPath(workdir: string): string {
  return join(workdir, ".nax", "config.json");
}

function readConfigJson(workdir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(workdir), "utf-8"));
}

function writeConfigJson(workdir: string, config: Record<string, unknown>): void {
  writeFileSync(configPath(workdir), JSON.stringify(config, null, 2));
}

describe("promptsInitCommand — auto-wires prompts.overrides", () => {
  let tempDir: string;
  let originalLog: typeof _promptsInitDeps.log;
  let originalWarn: typeof _promptsInitDeps.warn;
  let consoleOutput: string[];

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-config-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    consoleOutput = [];
    originalLog = _promptsInitDeps.log;
    originalWarn = _promptsInitDeps.warn;
    _promptsInitDeps.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    _promptsInitDeps.warn = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    _promptsInitDeps.log = originalLog;
    _promptsInitDeps.warn = originalWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("adds prompts.overrides to .nax/config.json when file exists and overrides not set", async () => {
    writeConfigJson(tempDir, { version: 1, models: {} });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const prompts = config.prompts as { overrides?: Record<string, string> };
    expect(prompts).toBeDefined();
    expect(prompts.overrides).toEqual(EXPECTED_OVERRIDES);
  });

  test("adds all 5 override keys: test-writer, implementer, verifier, single-session, tdd-simple", async () => {
    writeConfigJson(tempDir, { version: 1 });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const overrides = (config.prompts as { overrides?: Record<string, string> })?.overrides;
    assertDefined(overrides, "prompts.overrides");
    expect(Object.keys(overrides).sort()).toEqual(
      ["implementer", "single-session", "tdd-simple", "test-writer", "verifier"].sort(),
    );
  });

  test("each override path points to nax/templates/<role>.md", async () => {
    writeConfigJson(tempDir, { version: 1 });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const overrides = (config.prompts as { overrides?: Record<string, string> })?.overrides ?? {};
    expect(overrides["test-writer"]).toBe(".nax/templates/test-writer.md");
    expect(overrides.implementer).toBe(".nax/templates/implementer.md");
    expect(overrides.verifier).toBe(".nax/templates/verifier.md");
    expect(overrides["single-session"]).toBe(".nax/templates/single-session.md");
    expect(overrides["tdd-simple"]).toBe(".nax/templates/tdd-simple.md");
  });

  test("preserves existing config fields when adding prompts.overrides", async () => {
    const existing = { version: 1, models: { fast: "claude-haiku" }, execution: { maxIterations: 6 } };
    writeConfigJson(tempDir, existing);

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    expect(config.version).toBe(1);
    expect(config.models).toEqual({ fast: "claude-haiku" });
    expect((config.execution as { maxIterations: number }).maxIterations).toBe(6);
  });

  test("writes .nax/config.json with 2-space indentation", async () => {
    writeConfigJson(tempDir, { version: 1 });

    await promptsInitCommand({ workdir: tempDir });

    const raw = readFileSync(join(tempDir, ".nax", "config.json"), "utf-8");
    // 2-space indent means lines should start with exactly 2 spaces for top-level keys
    expect(raw).toMatch(/\n {2}"/);
    // Should NOT use 4-space or tab indentation
    expect(raw).not.toMatch(/\n {4}"/);
    expect(raw).not.toMatch(/\n\t/);
  });
});

describe("promptsInitCommand — does not overwrite existing prompts.overrides", () => {
  let tempDir: string;
  let originalLog: typeof _promptsInitDeps.log;
  let originalWarn: typeof _promptsInitDeps.warn;
  let consoleOutput: string[];

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-config-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    consoleOutput = [];
    originalLog = _promptsInitDeps.log;
    originalWarn = _promptsInitDeps.warn;
    _promptsInitDeps.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    _promptsInitDeps.warn = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    _promptsInitDeps.log = originalLog;
    _promptsInitDeps.warn = originalWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("does NOT modify prompts.overrides when already set", async () => {
    const customOverrides = { "test-writer": "custom/path/test-writer.md" };
    writeConfigJson(tempDir, {
      version: 1,
      prompts: { overrides: customOverrides },
    });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const overrides = (config.prompts as { overrides?: Record<string, string> })?.overrides;
    expect(overrides).toEqual(customOverrides);
  });

  test("does NOT modify prompts.overrides even if only one key is present", async () => {
    const partialOverrides = { implementer: "my-custom/implementer.md" };
    writeConfigJson(tempDir, {
      version: 1,
      prompts: { overrides: partialOverrides },
    });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const overrides = (config.prompts as { overrides?: Record<string, string> })?.overrides;
    expect(overrides).toEqual(partialOverrides);
  });

  test("prints a note when prompts.overrides already configured", async () => {
    writeConfigJson(tempDir, {
      version: 1,
      prompts: { overrides: { "test-writer": ".nax/templates/test-writer.md" } },
    });

    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n").toLowerCase();
    const mentionsAlreadyConfigured =
      allOutput.includes("already") ||
      allOutput.includes("existing") ||
      allOutput.includes("skip") ||
      allOutput.includes("override");
    expect(mentionsAlreadyConfigured).toBe(true);
  });
});

describe("promptsInitCommand — handles missing .nax/config.json gracefully", () => {
  let tempDir: string;
  let originalLog: typeof _promptsInitDeps.log;
  let originalWarn: typeof _promptsInitDeps.warn;
  let consoleOutput: string[];

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-config-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    consoleOutput = [];
    originalLog = _promptsInitDeps.log;
    originalWarn = _promptsInitDeps.warn;
    _promptsInitDeps.log = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
    _promptsInitDeps.warn = (...args: unknown[]) => {
      consoleOutput.push(args.map((a) => String(a)).join(" "));
    };
  });

  afterEach(() => {
    _promptsInitDeps.log = originalLog;
    _promptsInitDeps.warn = originalWarn;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("does NOT throw when .nax/config.json does not exist", async () => {
    expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(false);

    let threw = false;
    try {
      await promptsInitCommand({ workdir: tempDir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("still writes template files when .nax/config.json is missing", async () => {
    await promptsInitCommand({ workdir: tempDir });

    expect(existsSync(join(tempDir, ".nax", "templates", "test-writer.md"))).toBe(true);
    expect(existsSync(join(tempDir, ".nax", "templates", "implementer.md"))).toBe(true);
  });

  test("does NOT create .nax/config.json when it does not exist", async () => {
    await promptsInitCommand({ workdir: tempDir });

    expect(existsSync(join(tempDir, ".nax", "config.json"))).toBe(false);
  });

  test("prints manual instructions when .nax/config.json is missing", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n");
    // Should include the manual config snippet or instructions
    const mentionsManualConfig =
      allOutput.includes("prompts") ||
      allOutput.includes("config") ||
      allOutput.includes("override") ||
      allOutput.includes(".nax/config.json");
    expect(mentionsManualConfig).toBe(true);
  });

  // BUG-17: the auto-wire used to target `nax.config.json` — a file nothing
  // loads — so `[OK] Auto-wired` reported success into a dead file. The config
  // SSOT is `.nax/config.json`; a stray legacy `nax.config.json` must be
  // neither read nor written.
  test("BUG-17: a stray legacy nax.config.json is neither read nor written — wiring lands in .nax/config.json", async () => {
    writeConfigJson(tempDir, { version: 1 });
    const legacyPath = join(tempDir, "nax.config.json");
    const legacyContent = JSON.stringify({ version: 1, prompts: { overrides: { "test-writer": "legacy.md" } } });
    writeFileSync(legacyPath, legacyContent);

    await promptsInitCommand({ workdir: tempDir });

    // The legacy file is byte-identical — never read, never overwritten.
    expect(readFileSync(legacyPath, "utf-8")).toBe(legacyContent);
    // The real config got the auto-wired overrides.
    const config = readConfigJson(tempDir);
    expect((config.prompts as { overrides?: Record<string, string> })?.overrides).toEqual(EXPECTED_OVERRIDES);
  });

  test("BUG-17 hardening: a prompts section that is not an object is replaced, not crashed on", async () => {
    writeConfigJson(tempDir, { version: 1, prompts: "bogus" });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    expect((config.prompts as { overrides?: Record<string, string> })?.overrides).toEqual(EXPECTED_OVERRIDES);
  });
});

describe("promptsInitCommand — headless/non-TTY mode auto-writes config", () => {
  let tempDir: string;
  let originalLog: typeof _promptsInitDeps.log;
  let originalWarn: typeof _promptsInitDeps.warn;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-config-test-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    originalLog = _promptsInitDeps.log;
    originalWarn = _promptsInitDeps.warn;
    _promptsInitDeps.log = () => {};
    _promptsInitDeps.warn = () => {};

    // Simulate non-TTY mode
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    _promptsInitDeps.log = originalLog;
    _promptsInitDeps.warn = originalWarn;
    // Restore TTY state
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("auto-writes config without prompting in non-TTY mode", async () => {
    writeConfigJson(tempDir, { version: 1 });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const overrides = (config.prompts as { overrides?: Record<string, string> })?.overrides;
    expect(overrides).toEqual(EXPECTED_OVERRIDES);
  });
});
