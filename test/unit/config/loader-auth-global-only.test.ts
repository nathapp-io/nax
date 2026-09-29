/**
 * The global-only `auth` rule at every non-global config layer (US-001).
 *
 * `auth` may only be set in `~/.nax/config.json`. The loader rejects it, with
 * `NaxError` code `AUTH_CONFIG_NOT_GLOBAL`, in the project config, in every
 * profile (root and per-package chains, through `loadProfile`) and in both
 * per-package readers. `auth` set globally still reaches the merged config, so
 * `nax config` can show it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig, loadConfigForWorkdir, loadPackageOverride } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";
import { loadProfile } from "@/config/profile";
import type { NaxError } from "@/errors";

let globalDir: string;
let projectDir: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  globalDir = makeTempDir("nax-auth-global-");
  projectDir = makeTempDir("nax-auth-project-");
  savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
  mkdirSync(join(projectDir, ".nax"), { recursive: true });
  _clearRootConfigCache();
  _clearPackageConfigCache();
});

afterEach(() => {
  cleanupTempDir(globalDir);
  cleanupTempDir(projectDir);
  _clearRootConfigCache();
  _clearPackageConfigCache();
  if (savedGlobalEnv === undefined) {
    delete process.env.NAX_GLOBAL_CONFIG_DIR;
  } else {
    process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
  }
});

const AUTH_BLOCK = { auth: { source: "file" } };

async function catchNaxError(run: () => Promise<unknown>): Promise<NaxError> {
  try {
    await run();
  } catch (err) {
    assertNaxError(err, "config load rejection");
    return err;
  }
  throw new Error("expected a NaxError, but the call resolved");
}

/** Write a JSON config file, creating its parent directory. */
async function writeJson(path: string, content: Record<string, unknown>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(content));
}

/** The project-level `<project>/.nax/config.json` path for the current test. */
function projectConfigPath(): string {
  return join(projectDir, ".nax", "config.json");
}

describe("project layer rejects auth", () => {
  test("AC12: loadConfig throws AUTH_CONFIG_NOT_GLOBAL when <project>/.nax/config.json contains an auth key", async () => {
    await writeJson(projectConfigPath(), AUTH_BLOCK);

    const err = await catchNaxError(() => loadConfig(projectDir));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC13: the AUTH_CONFIG_NOT_GLOBAL error for <project>/.nax/config.json has a message containing project", async () => {
    await writeJson(projectConfigPath(), AUTH_BLOCK);

    const err = await catchNaxError(() => loadConfig(projectDir));

    expect(err.message).toContain("project");
  });
});

describe("profile layer rejects auth", () => {
  test("AC14: loadConfig throws AUTH_CONFIG_NOT_GLOBAL when the global profile declares an auth key", async () => {
    await writeJson(projectConfigPath(), {});
    await writeJson(join(globalDir, "profiles", "p.json"), AUTH_BLOCK);

    const err = await catchNaxError(() => loadConfig(projectDir, { profile: "p" }));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC15: loadProfile throws AUTH_CONFIG_NOT_GLOBAL for a profile containing an auth key", async () => {
    await writeJson(join(globalDir, "profiles", "p.json"), AUTH_BLOCK);

    const err = await catchNaxError(() => loadProfile("p", projectDir));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC15: the AUTH_CONFIG_NOT_GLOBAL error thrown by loadProfile names profile:p", async () => {
    await writeJson(join(globalDir, "profiles", "p.json"), AUTH_BLOCK);

    const err = await catchNaxError(() => loadProfile("p", projectDir));

    expect(err.message).toContain("profile:p");
  });

  test("AC16: loadConfig throws AUTH_CONFIG_NOT_GLOBAL when the project profile declares an auth key", async () => {
    await writeJson(projectConfigPath(), {});
    await writeJson(join(projectDir, ".nax", "profiles", "p.json"), AUTH_BLOCK);

    const err = await catchNaxError(() => loadConfig(projectDir, { profile: "p" }));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });
});

describe("per-package layer rejects auth", () => {
  function packageConfigPath(): string {
    return join(projectDir, ".nax", "mono", "packages", "a", "config.json");
  }

  test("AC17: loadConfigForWorkdir throws AUTH_CONFIG_NOT_GLOBAL when the per-package config contains an auth key", async () => {
    await writeJson(projectConfigPath(), {});
    await writeJson(packageConfigPath(), AUTH_BLOCK);

    const err = await catchNaxError(() => loadConfigForWorkdir(projectConfigPath(), "packages/a"));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC18: loadPackageOverride throws AUTH_CONFIG_NOT_GLOBAL when the per-package config contains an auth key", async () => {
    await writeJson(packageConfigPath(), AUTH_BLOCK);

    const err = await catchNaxError(() => loadPackageOverride(projectDir, "packages/a"));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });

  test("AC19: loadConfigForWorkdir throws AUTH_CONFIG_NOT_GLOBAL when a selected package profile contains an auth key", async () => {
    await writeJson(projectConfigPath(), {});
    await writeJson(packageConfigPath(), { profile: "pp" });
    await writeJson(join(projectDir, "packages", "a", ".nax", "profiles", "pp.json"), AUTH_BLOCK);

    const err = await catchNaxError(() => loadConfigForWorkdir(projectConfigPath(), "packages/a"));

    expect(err.code).toBe("AUTH_CONFIG_NOT_GLOBAL");
  });
});

describe("global auth reaches the merged config", () => {
  test('AC20: loadConfig returns auth.source equal to "exec" when only the global config sets auth', async () => {
    await writeJson(projectConfigPath(), {});
    await writeJson(join(globalDir, "config.json"), { auth: { source: "exec", exec: { command: ["h"] } } });

    const config = await loadConfig(projectDir);

    expect(config.auth?.source).toBe("exec");
  });
});
