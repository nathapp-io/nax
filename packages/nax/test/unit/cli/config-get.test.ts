/**
 * `loadGlobalConfig` (the global side of `nax config --diff`) reads the whole
 * global layer: `config.json` with the per-machine `config.local.json` over it (#2827).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadGlobalConfig } from "@/cli/config-get";

let globalDir: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  globalDir = makeTempDir("nax-config-get-global-");
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

function costLimitOf(config: Record<string, unknown>): unknown {
  const execution = config.execution;
  return typeof execution === "object" && execution !== null ? Reflect.get(execution, "costLimit") : undefined;
}

describe("loadGlobalConfig", () => {
  test("merges config.local.json over config.json", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ execution: { costLimit: 3 } }), "utf8");
    writeFileSync(join(globalDir, "config.local.json"), JSON.stringify({ execution: { costLimit: 7 } }), "utf8");

    expect(costLimitOf(await loadGlobalConfig())).toBe(7);
  });

  test("applies config.local.json when config.json is absent", async () => {
    writeFileSync(join(globalDir, "config.local.json"), JSON.stringify({ execution: { costLimit: 9 } }), "utf8");

    expect(costLimitOf(await loadGlobalConfig())).toBe(9);
  });

  test("uses config.json alone when there is no config.local.json", async () => {
    writeFileSync(join(globalDir, "config.json"), JSON.stringify({ execution: { costLimit: 4 } }), "utf8");

    expect(costLimitOf(await loadGlobalConfig())).toBe(4);
  });
});
