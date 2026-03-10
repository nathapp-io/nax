/**
 * Unit tests for PE-002: Auto-configure prompts.overrides when templates exist
 *
 * Tests that promptsInitCommand auto-wires prompts.overrides into nax.config.json
 * after writing template files.
 */

import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promptsInitCommand } from "../../../src/cli/prompts";

const EXPECTED_OVERRIDES = {
  "test-writer": "nax/templates/test-writer.md",
  implementer: "nax/templates/implementer.md",
  verifier: "nax/templates/verifier.md",
  "single-session": "nax/templates/single-session.md",
  "tdd-simple": "nax/templates/tdd-simple.md",
};

function readConfigJson(workdir: string): Record<string, unknown> {
  const configPath = join(workdir, "nax.config.json");
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

function writeConfigJson(workdir: string, config: Record<string, unknown>): void {
  writeFileSync(join(workdir, "nax.config.json"), JSON.stringify(config, null, 2));
}

describe("promptsInitCommand — auto-wires prompts.overrides", () => {
  let tempDir: string;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let consoleOutput: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-config-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });

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

  test("adds prompts.overrides to nax.config.json when file exists and overrides not set", async () => {
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
    expect(overrides).toBeDefined();
    expect(Object.keys(overrides!).sort()).toEqual(
      ["implementer", "single-session", "tdd-simple", "test-writer", "verifier"].sort(),
    );
  });

  test("each override path points to nax/templates/<role>.md", async () => {
    writeConfigJson(tempDir, { version: 1 });

    await promptsInitCommand({ workdir: tempDir });

    const config = readConfigJson(tempDir);
    const overrides = (config.prompts as { overrides?: Record<string, string> })?.overrides ?? {};
    expect(overrides["test-writer"]).toBe("nax/templates/test-writer.md");
    expect(overrides["implementer"]).toBe("nax/templates/implementer.md");
    expect(overrides["verifier"]).toBe("nax/templates/verifier.md");
    expect(overrides["single-session"]).toBe("nax/templates/single-session.md");
    expect(overrides["tdd-simple"]).toBe("nax/templates/tdd-simple.md");
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

  test("writes nax.config.json with 2-space indentation", async () => {
    writeConfigJson(tempDir, { version: 1 });

    await promptsInitCommand({ workdir: tempDir });

    const raw = readFileSync(join(tempDir, "nax.config.json"), "utf-8");
    // 2-space indent means lines should start with exactly 2 spaces for top-level keys
    expect(raw).toMatch(/\n {2}"/);
    // Should NOT use 4-space or tab indentation
    expect(raw).not.toMatch(/\n {4}"/);
    expect(raw).not.toMatch(/\n\t/);
  });
});

describe("promptsInitCommand — does not overwrite existing prompts.overrides", () => {
  let tempDir: string;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let consoleOutput: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-config-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });

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
      prompts: { overrides: { "test-writer": "nax/templates/test-writer.md" } },
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

describe("promptsInitCommand — handles missing nax.config.json gracefully", () => {
  let tempDir: string;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let consoleOutput: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-config-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });

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

  test("does NOT throw when nax.config.json does not exist", async () => {
    expect(existsSync(join(tempDir, "nax.config.json"))).toBe(false);

    let threw = false;
    try {
      await promptsInitCommand({ workdir: tempDir });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  test("still writes template files when nax.config.json is missing", async () => {
    await promptsInitCommand({ workdir: tempDir });

    expect(existsSync(join(tempDir, "nax", "templates", "test-writer.md"))).toBe(true);
    expect(existsSync(join(tempDir, "nax", "templates", "implementer.md"))).toBe(true);
  });

  test("does NOT create nax.config.json when it does not exist", async () => {
    await promptsInitCommand({ workdir: tempDir });

    expect(existsSync(join(tempDir, "nax.config.json"))).toBe(false);
  });

  test("prints manual instructions when nax.config.json is missing", async () => {
    await promptsInitCommand({ workdir: tempDir });

    const allOutput = consoleOutput.join("\n");
    // Should include the manual config snippet or instructions
    const mentionsManualConfig =
      allOutput.includes("prompts") ||
      allOutput.includes("config") ||
      allOutput.includes("override") ||
      allOutput.includes("nax.config.json");
    expect(mentionsManualConfig).toBe(true);
  });
});

describe("promptsInitCommand — headless/non-TTY mode auto-writes config", () => {
  let tempDir: string;
  let originalConsoleLog: typeof console.log;
  let originalConsoleWarn: typeof console.warn;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "nax-prompts-config-test-"));
    mkdirSync(join(tempDir, "nax"), { recursive: true });

    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};

    // Simulate non-TTY mode
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
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
