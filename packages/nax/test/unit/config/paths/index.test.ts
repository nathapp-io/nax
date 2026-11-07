/**
 * #2827: the project walk-up never treats the global config dir as a project.
 *
 * `findProjectDir` walks up from a working directory to
 * the nearest `.nax/config.json`. Started under the directory that holds the
 * global `.nax/` (normally `$HOME`) with no nearer project config, it used to
 * stop at the global dir and hand it back as the project, so `loadConfig` loaded
 * the global config a second time as the project layer and rejected its `auth`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { findProjectDir, loadConfig } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _clearPackageConfigCache } from "@/config/package-config-cache";

let home: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  home = makeTempDir("nax-2827-home-");
  savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = join(home, ".nax");
  _clearRootConfigCache();
  _clearPackageConfigCache();
});

afterEach(() => {
  cleanupTempDir(home);
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

/** A directory under `home` with no `.nax/` of its own. */
function scratchDir(): string {
  const dir = join(home, "scratch", "deep");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("findProjectDir skips the global config dir", () => {
  test("returns null when the only .nax/config.json above the start dir is the global one", async () => {
    await writeJson(join(home, ".nax", "config.json"), {});

    expect(findProjectDir(scratchDir())).toBeNull();
  });

  test("still finds a real project config between the start dir and the global dir", async () => {
    await writeJson(join(home, ".nax", "config.json"), {});
    await writeJson(join(home, "scratch", ".nax", "config.json"), {});

    expect(findProjectDir(scratchDir())).toBe(join(home, "scratch", ".nax"));
  });

  test("skips the global dir when NAX_GLOBAL_CONFIG_DIR is a symlink to it", async () => {
    await writeJson(join(home, ".nax", "config.json"), {});
    const link = join(home, "global-link");
    symlinkSync(join(home, ".nax"), link);
    process.env.NAX_GLOBAL_CONFIG_DIR = link;

    expect(findProjectDir(scratchDir())).toBeNull();
  });

  test("skips the global dir when it is itself a symlink and the walk meets the link", async () => {
    const realGlobal = join(home, "synced-repo");
    await writeJson(join(realGlobal, "config.json"), {});
    symlinkSync(realGlobal, join(home, ".nax"));

    expect(findProjectDir(scratchDir())).toBeNull();
  });
});

describe("loadConfig from a dir under the global dir's parent", () => {
  test("loads a global config holding auth without AUTH_CONFIG_NOT_GLOBAL", async () => {
    await writeJson(join(home, ".nax", "config.json"), { auth: { source: "exec", exec: { command: ["h"] } } });

    const config = await loadConfig(scratchDir());

    expect(config.auth?.source).toBe("exec");
  });
});
