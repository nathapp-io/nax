// test/unit/config/scoped-profile-guard.test.ts
//
// The "scoped" permission profile and the `execution.permissions` policy
// block used to be rejected outright (GitHub #374) while nothing enforced
// them. Enforcement now exists (see `test/unit/config/scoped-profile-accepted.test.ts`
// for the acceptance + validator coverage), so this file is left only with
// the profile values that were never part of the rejected feature.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig } from "@/config";

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

  test("a config with no permissions block loads normally", async () => {
    const root = await writeProjectConfig({ execution: { permissionProfile: "unrestricted" } });
    const config = await loadConfig(root);
    expect(config.execution.permissionProfile).toBe("unrestricted");
  });
});
