/**
 * Acceptance Tests for config-ssot Feature
 *
 * Verifies that DEFAULT_CONFIG is derived from NaxConfigSchema.parse({})
 * and that schemas.ts does not import from defaults.ts (SSOT principle).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { loadConfig } from "../../../src/config/loader";
import type { NaxConfig } from "../../../src/config/schema";
import { NaxConfigSchema } from "../../../src/config/schemas";

describe("AC-1: schemas.ts does not import from defaults.ts", () => {
  test("schemas.ts has no import statements matching ./defaults or ./defaults.ts", () => {
    const schemasPath = resolve(import.meta.dir, "../../../src/config/schemas.ts");
    const content = readFileSync(schemasPath, "utf-8");
    const importDefaultsRegex = /^import\s+.*\s+from\s+['"]\.\/defaults(\.ts)?['"]/gm;
    const matches = content.match(importDefaultsRegex);
    expect(matches).toBeNull();
  });
});

describe("AC-2: NaxConfigSchema.parse({}).autoMode.defaultAgent === 'claude'", () => {
  test("defaultAgent is 'claude'", () => {
    expect(NaxConfigSchema.parse({}).autoMode.defaultAgent).toBe("claude");
  });
});

describe("AC-3: NaxConfigSchema.parse({}).debate.enabled === false", () => {
  test("debate.enabled is false", () => {
    expect(NaxConfigSchema.parse({}).debate.enabled).toBe(false);
  });
});

describe("AC-4: NaxConfigSchema.parse({}).debate.stages.plan.enabled === true", () => {
  test("debate.stages.plan.enabled is true", () => {
    expect(NaxConfigSchema.parse({}).debate.stages.plan.enabled).toBe(true);
  });
});

describe("AC-5: debate config from schema parse equals DEFAULT_CONFIG.debate", () => {
  test("JSON.stringify(NaxConfigSchema.parse({}).debate) === JSON.stringify(DEFAULT_CONFIG.debate)", () => {
    const schemaDebate = NaxConfigSchema.parse({}).debate;
    const defaultDebate = DEFAULT_CONFIG.debate;
    expect(JSON.stringify(schemaDebate)).toBe(JSON.stringify(defaultDebate));
  });
});

describe("AC-6: DEFAULT_CONFIG type compatibility", () => {
  test("DEFAULT_CONFIG is assignable to NaxConfig type", () => {
    const config: NaxConfig = DEFAULT_CONFIG;
    expect(config).toBeDefined();
  });

  test("DEFAULT_CONFIG is exported and not undefined", () => {
    expect(DEFAULT_CONFIG).toBeDefined();
    expect(DEFAULT_CONFIG).not.toBeUndefined();
  });
});

describe("AC-7: defaults.ts file line count < 15", () => {
  test("defaults.ts has fewer than 15 lines", () => {
    const defaultsPath = resolve(import.meta.dir, "../../../src/config/defaults.ts");
    const content = readFileSync(defaultsPath, "utf-8");
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeLessThan(15);
  });
});

describe("AC-8: DEFAULT_CONFIG.execution.sessionTimeoutSeconds === 3600", () => {
  test("sessionTimeoutSeconds is 3600", () => {
    expect(DEFAULT_CONFIG.execution.sessionTimeoutSeconds).toBe(3600);
  });
});

describe("AC-9: DEFAULT_CONFIG.execution.rectification.maxRetries === 2", () => {
  test("rectification.maxRetries is 2", () => {
    expect(DEFAULT_CONFIG.execution.rectification.maxRetries).toBe(2);
  });
});

describe("AC-10: DEFAULT_CONFIG.quality.requireTypecheck === true", () => {
  test("requireTypecheck is true", () => {
    expect(DEFAULT_CONFIG.quality.requireTypecheck).toBe(true);
  });
});

describe("AC-11: loadConfig with no files returns DEFAULT_CONFIG", () => {
  test("loadConfig(tempDir) equals DEFAULT_CONFIG when no config files exist", async () => {
    const { mkdirSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { globalConfigPath } = await import("../../../src/config/loader");

    const tempDir = join(tmpdir(), `nax-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    const globalPath = globalConfigPath();
    let globalBackup: string | null = null;
    if (existsSync(globalPath)) {
      globalBackup = `${globalPath}.backup-${Date.now()}`;
      const { renameSync } = await import("node:fs");
      renameSync(globalPath, globalBackup);
    }

    try {
      const result = await loadConfig(tempDir);
      expect(result).toEqual(DEFAULT_CONFIG);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (globalBackup && existsSync(globalBackup)) {
        const { renameSync } = await import("node:fs");
        renameSync(globalBackup, globalPath);
      }
    }
  });
});

describe("AC-12: defaults-ssot.test.ts file exists", () => {
  test("test/unit/config/defaults-ssot.test.ts exists", () => {
    const testPath = resolve(import.meta.dir, "../../../test/unit/config/defaults-ssot.test.ts");
    expect(existsSync(testPath)).toBe(true);
  });
});

describe("AC-13: NaxConfigSchema.parse({}) toStrictEqual DEFAULT_CONFIG", () => {
  test("schema parse produces result strictly equal to DEFAULT_CONFIG", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
  });
});

describe("AC-14: every key in DEFAULT_CONFIG exists in schema parse result", () => {
  test("Object.keys(DEFAULT_CONFIG).every(key => key in NaxConfigSchema.parse({}))", () => {
    const parsed = NaxConfigSchema.parse({});
    const defaultKeys = Object.keys(DEFAULT_CONFIG);
    const allKeysPresent = defaultKeys.every((key) => key in parsed);
    expect(allKeysPresent).toBe(true);
  });
});

describe("AC-15: NaxConfigSchema.parse({}) does not throw", () => {
  test("expect(() => NaxConfigSchema.parse({})).not.toThrow()", () => {
    expect(() => NaxConfigSchema.parse({})).not.toThrow();
  });
});

describe("AC-16: bun test exits with code 0 for defaults.test.ts", () => {
  test("bun test test/unit/config/defaults.test.ts exits with code 0", async () => {
    const { spawnSync } = await import("bun");
    const projectRoot = resolve(import.meta.dir, "../../../..");
    const result = spawnSync(["bun", "test", "test/unit/config/defaults.test.ts"], {
      cwd: projectRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    expect(result.exitCode).toBe(0);
  });
});
