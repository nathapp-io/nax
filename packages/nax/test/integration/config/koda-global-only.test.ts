/**
 * `memory.koda` across the real config layers (US-012).
 *
 * `memory.koda.url` and `memory.koda.headers` are global-only: the koda bearer
 * key must not be chosen by a repository, a profile or a per-package override.
 * `memory.koda.project` is allowed in every layer, because that is what
 * `nax memory link` writes into the project config. Both tests load real files
 * from a temporary global directory (`NAX_GLOBAL_CONFIG_DIR`) so no literal
 * credential reaches the developer's own configuration.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";
import type { NaxError } from "@/errors";

let globalDir: string;
let projectDir: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  globalDir = makeTempDir("nax-koda-global-");
  projectDir = makeTempDir("nax-koda-project-");
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

async function writeJson(path: string, content: Record<string, unknown>): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(content));
}

function projectConfigPath(): string {
  return join(projectDir, ".nax", "config.json");
}

function globalConfigPath(): string {
  return join(globalDir, "config.json");
}

async function catchNaxError(run: () => Promise<unknown>): Promise<NaxError> {
  try {
    await run();
  } catch (err) {
    assertNaxError(err, "config load rejection");
    return err;
  }
  throw new Error("expected a NaxError, but the call resolved");
}

describe("memory.koda.url is global-only (US-012)", () => {
  test("AC-4: loadConfig rejects a project config that sets memory.koda.url", async () => {
    await writeJson(projectConfigPath(), { memory: { koda: { url: "https://koda.example/api" } } });

    const err = await catchNaxError(() => loadConfig(projectDir));

    expect(err.code).toBe("MEMORY_KODA_CONFIG_NOT_GLOBAL");
  });

  test("AC-4: the refusal names memory.koda.url and the project layer", async () => {
    await writeJson(projectConfigPath(), { memory: { koda: { url: "https://koda.example/api" } } });

    const err = await catchNaxError(() => loadConfig(projectDir));

    expect(err.message).toBe("memory.koda.url belongs in ~/.nax/config.json and cannot be set in project");
  });
});

describe("the two layers union (US-012)", () => {
  test("AC-5: loadConfig resolves memory.koda to the union of the global and project layers", async () => {
    await writeJson(globalConfigPath(), {
      memory: { koda: { url: "https://koda.example/api", headers: { Authorization: "Bearer x" } } },
    });
    await writeJson(projectConfigPath(), { memory: { provider: "koda", koda: { project: "rs-stock" } } });

    const config = await loadConfig(projectDir);

    expect(config.memory?.provider).toBe("koda");
    expect(config.memory?.koda).toEqual({
      url: "https://koda.example/api",
      project: "rs-stock",
      headers: { Authorization: "Bearer x" },
    });
  });

  test("AC-5: the global-only keys survive while the project layer adds only the project", async () => {
    await writeJson(globalConfigPath(), {
      memory: { koda: { url: "https://koda.example/api", headers: { Authorization: "Bearer x" } } },
    });
    await writeJson(projectConfigPath(), { memory: { provider: "koda", koda: { project: "rs-stock" } } });

    const config = await loadConfig(projectDir);

    expect(config.memory?.koda?.url).toBe("https://koda.example/api");
    expect(config.memory?.koda?.project).toBe("rs-stock");
    expect(config.memory?.koda?.headers).toEqual({ Authorization: "Bearer x" });
  });
});
