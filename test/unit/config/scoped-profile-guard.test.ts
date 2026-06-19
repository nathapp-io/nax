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
import { loadConfig } from "@/config";
import { NaxError } from "@/errors";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

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
});
