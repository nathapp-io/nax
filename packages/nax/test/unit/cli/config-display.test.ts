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
import type { NaxConfig } from "@/config";
import { DEFAULT_CONFIG } from "@/config";

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
