/**
 * Tests for src/cli/config-display.ts
 *
 * SEC-05: `nax config` (default view) printed the fully resolved config,
 * including resolved secrets (e.g. models.<agent>.<tier>.env values), as
 * plaintext JSON. Verify the default view masks sensitive keys/values the
 * same way `nax config profile show` already does.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { configCommand } from "@/cli";
import { determineConfigSources } from "@/cli/config-display";
import { configDisplayAction } from "@/cli/config-display-action";
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";

describe("configDisplayAction — selected directory (US-011 AC-4/AC-5)", () => {
  let selectedDir: string;
  let cwdDir: string;
  let globalDir: string;
  let originalCwd: string;
  let savedGlobalEnv: string | undefined;

  beforeEach(() => {
    selectedDir = realpathSync(makeTempDir("nax-config-action-selected-"));
    cwdDir = realpathSync(makeTempDir("nax-config-action-cwd-"));
    globalDir = makeTempDir("nax-config-action-global-");
    originalCwd = process.cwd();
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    mkdirSync(join(selectedDir, ".nax"), { recursive: true });
    mkdirSync(join(cwdDir, ".nax"), { recursive: true });
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ execution: { costLimit: 2 } }), "utf8");
    writeFileSync(join(selectedDir, ".nax", "config.json"), JSON.stringify({ execution: { costLimit: 9 } }), "utf8");
    writeFileSync(join(cwdDir, ".nax", "config.json"), JSON.stringify({ execution: { costLimit: 3 } }), "utf8");
    process.chdir(cwdDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(selectedDir);
    cleanupTempDir(cwdDir);
    cleanupTempDir(globalDir);
    if (savedGlobalEnv === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
  });

  test("AC-4: diff displays overrides from the selected project's config", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
      await configDisplayAction({ dir: selectedDir, diff: true });
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toContain("execution.costLimit");
    expect(output.join("\n")).toContain("9");
  });

  test("AC-5: default view names the selected project's config source", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
    try {
      await configDisplayAction({ dir: selectedDir });
    } finally {
      console.log = originalLog;
    }

    expect(output.join("\n")).toContain(join(selectedDir, ".nax", "config.json"));
    expect(output.join("\n")).not.toContain(join(cwdDir, ".nax", "config.json"));
  });
});

describe("configCommand — SEC-05: default view masks secrets", () => {
  let consoleOutput: string[];
  const originalLog = console.log;

  beforeEach(() => {
    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("masks a resolved API key nested under models.<agent>.<tier>.env", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      models: {
        ...DEFAULT_CONFIG.models,
        claude: {
          fast: { model: "claude-fast", provider: "anthropic", env: { OPENAI_API_KEY: "sk-live-super-secret-value" } },
        },
      },
    };

    await configCommand(config, {});

    const output = consoleOutput.join("\n");
    expect(output).not.toContain("sk-live-super-secret-value");
    expect(output).toContain("***");
  });

  test("non-sensitive fields are still printed in plain form", async () => {
    const config = { ...DEFAULT_CONFIG } as NaxConfig;

    await configCommand(config, {});

    const output = consoleOutput.join("\n");
    expect(output).toContain("nax Configuration");
  });
});

describe("configCommand — US-005 AC23: --diff rejects a profile chain", () => {
  const originalError = console.error;
  const originalExit = process.exit;

  afterEach(() => {
    console.error = originalError;
    process.exit = originalExit;
  });

  test("US-005 AC23 names --diff and --profile then exits 1", async () => {
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(" "));
    };
    let exitCode: number | undefined;
    process.exit = (code?: number): never => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    };

    await expect(configCommand(DEFAULT_CONFIG, { diff: true, profile: ["p"] })).rejects.toThrow("process.exit(1)");

    expect(exitCode).toBe(1);
    const message = errors.join("\n");
    expect(message).toContain("--diff");
    expect(message).toContain("--profile");
  });
});

describe("determineConfigSources — US-005 AC24: start-directory argument", () => {
  test("US-005 AC24 resolves the project config under the given start directory", () => {
    const projectRoot = realpathSync(makeTempDir("nax-config-sources-"));
    try {
      mkdirSync(join(projectRoot, ".nax"), { recursive: true });
      writeFileSync(join(projectRoot, ".nax", "config.json"), "{}", "utf8");

      const sources = determineConfigSources(projectRoot);

      expect(sources.project).toBe(join(projectRoot, ".nax", "config.json"));
    } finally {
      cleanupTempDir(projectRoot);
    }
  });
});

describe("determineConfigSources — #2827: per-machine global config", () => {
  let globalDir: string;
  let savedGlobalEnv: string | undefined;

  beforeEach(() => {
    globalDir = makeTempDir("nax-config-sources-global-");
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  });

  afterEach(() => {
    cleanupTempDir(globalDir);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
  });

  test("reports config.local.json when it exists in the global config dir", () => {
    const local = join(globalDir, "config.local.json");
    writeFileSync(local, "{}", "utf8");

    expect(determineConfigSources(globalDir).globalLocal).toBe(local);
  });

  test("reports null for config.local.json when it is absent", () => {
    expect(determineConfigSources(globalDir).globalLocal).toBeNull();
  });
});
