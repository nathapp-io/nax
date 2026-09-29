/**
 * readGlobalAuthConfig — the credential module's single, global-only source of
 * the `auth` block (US-001).
 *
 * The reader must build its path from `globalConfigDir()` and never consult the
 * merged run config, so every caller that builds a native client sees the same
 * source. `NAX_GLOBAL_CONFIG_DIR` points at a fresh temp dir per test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { readGlobalAuthConfig } from "@/config/global-only-keys";
import type { NaxError } from "@/errors";

let globalDir: string;
let savedGlobalEnv: string | undefined;

beforeEach(() => {
  globalDir = makeTempDir("nax-auth-global-");
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

async function writeGlobalConfig(content: Record<string, unknown>): Promise<void> {
  await Bun.write(join(globalDir, "config.json"), JSON.stringify(content));
}

async function catchNaxError(run: () => Promise<unknown>): Promise<NaxError> {
  try {
    await run();
  } catch (err) {
    assertNaxError(err, "readGlobalAuthConfig rejection");
    return err;
  }
  throw new Error("expected a NaxError, but the call resolved");
}

describe("readGlobalAuthConfig", () => {
  test('AC9: returns source "file" when the global config.json does not exist', async () => {
    const config = await readGlobalAuthConfig();

    expect(config.source).toBe("file");
  });

  test('AC9: returns source "file" when the global config.json exists without an auth block', async () => {
    await writeGlobalConfig({ quality: { commands: { test: "bun test" } } });

    const config = await readGlobalAuthConfig();

    expect(config.source).toBe("file");
  });

  test('AC10: returns exec.command equal to ["koda-cred"] when the global config.json declares the exec source', async () => {
    await writeGlobalConfig({ auth: { source: "exec", exec: { command: ["koda-cred"] } } });

    const config = await readGlobalAuthConfig();

    expect(config.exec?.command).toEqual(["koda-cred"]);
  });

  test("AC11: throws NaxError AUTH_CONFIG_INVALID when the global auth block selects exec without a command", async () => {
    await writeGlobalConfig({ auth: { source: "exec" } });

    const err = await catchNaxError(() => readGlobalAuthConfig());

    expect(err.code).toBe("AUTH_CONFIG_INVALID");
  });
});
