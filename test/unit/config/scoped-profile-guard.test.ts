// test/unit/config/scoped-profile-guard.test.ts
//
// Regression guard for the not-yet-implemented "scoped" permission profile
// (GitHub #374). The scoped resolver is still a stub that returns "safe"
// defaults, so loading a config with `permissionProfile: "scoped"` must throw
// fast rather than silently downgrading the user to weaker permissions.
//
// Remove this guard (and these tests) when scoped permissions are implemented.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig } from "@/config";
import { NaxError } from "@/errors";

const tempDirs: string[] = [];

async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-scoped-guard-");
  tempDirs.push(root);
  const naxDir = join(root, ".nax");
  await mkdir(naxDir, { recursive: true });
  await Bun.write(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

describe("scoped permission profile — unimplemented guard (#374)", () => {
  beforeEach(() => {
    tempDirs.splice(0, tempDirs.length);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  test('rejects execution.permissionProfile: "scoped" with a pointer to #374', async () => {
    const root = await writeProjectConfig({
      execution: { permissionProfile: "scoped" },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_SCOPED_PROFILE_UNIMPLEMENTED");
      expect(e.message).toContain("#374");
      expect(e.message).toContain("not yet implemented");
    }
  });

  test('accepts execution.permissionProfile: "unrestricted"', async () => {
    const root = await writeProjectConfig({
      execution: { permissionProfile: "unrestricted" },
    });
    const config = await loadConfig(root);
    expect(config.execution.permissionProfile).toBe("unrestricted");
  });

  test('accepts execution.permissionProfile: "safe"', async () => {
    const root = await writeProjectConfig({
      execution: { permissionProfile: "safe" },
    });
    const config = await loadConfig(root);
    expect(config.execution.permissionProfile).toBe("safe");
  });

  // `execution.permissions` is the per-stage policy block belonging to the same
  // unimplemented feature. The schema accepted and validated it while nothing in
  // src/ ever read it, so a user could write a permission policy, see no error,
  // and get no enforcement. Same treatment as the profile value it belongs to.
  test("rejects the execution.permissions policy block with a pointer to #374", async () => {
    const root = await writeProjectConfig({
      execution: { permissions: { run: { mode: "approve-reads", allowedTools: ["read"] } } },
    });
    try {
      await loadConfig(root);
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NaxError);
      const e = err as NaxError;
      expect(e.code).toBe("CONFIG_PERMISSIONS_BLOCK_UNIMPLEMENTED");
      expect(e.message).toContain("#374");
      expect(e.message).toContain("execution.permissions");
    }
  });

  test("an empty execution.permissions block is still rejected", async () => {
    const root = await writeProjectConfig({ execution: { permissions: {} } });
    await expect(loadConfig(root)).rejects.toThrow(/execution\.permissions/);
  });

  test("a config with no permissions block loads normally", async () => {
    const root = await writeProjectConfig({ execution: { permissionProfile: "unrestricted" } });
    const config = await loadConfig(root);
    expect(config.execution.permissionProfile).toBe("unrestricted");
  });
});
