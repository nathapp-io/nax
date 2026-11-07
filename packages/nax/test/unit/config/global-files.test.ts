/**
 * #2827: `~/.nax/config.local.json` is a per-machine part of the global layer.
 *
 * A global dir shared across machines (a synced repo) cannot hold per-machine
 * settings such as an `auth.exec.command` with absolute paths. The optional
 * `config.local.json` next to `config.json` is deep-merged over it, may hold
 * global-only keys, and is read both by `loadConfig` and `readGlobalAuthConfig`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig, readGlobalAuthConfig } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";

let globalDir: string;
let projectDir: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  globalDir = makeTempDir("nax-2827-global-");
  projectDir = makeTempDir("nax-2827-project-");
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

const EXEC_AUTH = { auth: { source: "exec", exec: { command: ["local-cred"] } } };

describe("loadConfig merges config.local.json over config.json", () => {
  test("a key set in both files takes the config.local.json value", async () => {
    await writeJson(join(projectDir, ".nax", "config.json"), {});
    await writeJson(join(globalDir, "config.json"), { execution: { costLimit: 3 } });
    await writeJson(join(globalDir, "config.local.json"), { execution: { costLimit: 7 } });

    const config = await loadConfig(projectDir);

    expect(config.execution.costLimit).toBe(7);
  });

  test("auth set only in config.local.json reaches the merged config", async () => {
    await writeJson(join(projectDir, ".nax", "config.json"), {});
    await writeJson(join(globalDir, "config.json"), {});
    await writeJson(join(globalDir, "config.local.json"), EXEC_AUTH);

    const config = await loadConfig(projectDir);

    expect(config.auth?.source).toBe("exec");
  });

  test("config.local.json applies when there is no config.json", async () => {
    await writeJson(join(projectDir, ".nax", "config.json"), {});
    await writeJson(join(globalDir, "config.local.json"), { execution: { costLimit: 9 } });

    const config = await loadConfig(projectDir);

    expect(config.execution.costLimit).toBe(9);
  });

  test("the project layer still wins over config.local.json", async () => {
    await writeJson(join(projectDir, ".nax", "config.json"), { execution: { costLimit: 2 } });
    await writeJson(join(globalDir, "config.local.json"), { execution: { costLimit: 9 } });

    const config = await loadConfig(projectDir);

    expect(config.execution.costLimit).toBe(2);
  });

  test("malformed config.local.json fails the load instead of being skipped", async () => {
    await writeJson(join(projectDir, ".nax", "config.json"), {});
    await Bun.write(join(globalDir, "config.local.json"), "{ not json");

    let caught: unknown;
    try {
      await loadConfig(projectDir);
    } catch (err) {
      caught = err;
    }

    assertNaxError(caught, "malformed config.local.json");
    expect(caught.code).toBe("JSON_FILE_PARSE_FAILED");
  });
});

describe("readGlobalAuthConfig reads config.local.json", () => {
  test("returns the auth from config.local.json when config.json has none", async () => {
    await writeJson(join(globalDir, "config.json"), {});
    await writeJson(join(globalDir, "config.local.json"), EXEC_AUTH);

    const auth = await readGlobalAuthConfig();

    expect(auth.source).toBe("exec");
    expect(auth.exec?.command).toEqual(["local-cred"]);
  });

  test("config.local.json auth overrides config.json auth", async () => {
    await writeJson(join(globalDir, "config.json"), { auth: { source: "file" } });
    await writeJson(join(globalDir, "config.local.json"), EXEC_AUTH);

    const auth = await readGlobalAuthConfig();

    expect(auth.source).toBe("exec");
  });

  test("keeps config.json auth when config.local.json is absent", async () => {
    await writeJson(join(globalDir, "config.json"), { auth: { source: "exec", exec: { command: ["shared"] } } });

    const auth = await readGlobalAuthConfig();

    expect(auth.exec?.command).toEqual(["shared"]);
  });
});

describe("readGlobalAuthConfig still rejects a malformed auth value", () => {
  test("a non-object auth in config.local.json fails with AUTH_CONFIG_INVALID", async () => {
    await writeJson(join(globalDir, "config.local.json"), { auth: "exec" });

    let caught: unknown;
    try {
      await readGlobalAuthConfig();
    } catch (err) {
      caught = err;
    }

    assertNaxError(caught, "malformed local auth");
    expect(caught.code).toBe("AUTH_CONFIG_INVALID");
  });
});
