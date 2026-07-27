// test/unit/config/dead-quality-flags.test.ts
//
// Regression guard for the removal of `quality.requireTypecheck`,
// `quality.requireLint`, and `quality.requireTests`.
//
// These three flags were declared in the schema, carried through
// runtime-types and per-package merge, and documented in the CLI — but read at
// no gate site. Gates fired whenever a command resolved, regardless of the
// flag. A reviewer once reasoned "gates run because those flags are true",
// reaching the right conclusion via a flag that did nothing.
//
// They are removed rather than wired: wiring would be a silent behaviour
// change for anyone who set one to `false` and has been getting the gate
// anyway. Removing changes no behaviour — but Zod's default .strip() would
// swallow the keys and leave the user believing the override still applies, so
// the removal is guarded explicitly (config-patterns.md: "a removal that would
// silently drop behaviour must be a pre-parse guard").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { loadConfig } from "@/config";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const tempDirs: string[] = [];

async function writeProjectConfig(contents: object): Promise<string> {
  const root = makeTempDir("nax-dead-quality-");
  tempDirs.push(root);
  const naxDir = join(root, ".nax");
  await mkdir(naxDir, { recursive: true });
  await Bun.write(join(naxDir, "config.json"), JSON.stringify(contents, null, 2));
  return root;
}

describe("dead quality flags — removal guard", () => {
  beforeEach(() => {
    tempDirs.splice(0, tempDirs.length);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  for (const key of ["requireTypecheck", "requireLint", "requireTests"] as const) {
    test(`throws when quality.${key} is set`, async () => {
      const root = await writeProjectConfig({ quality: { [key]: false } });
      expect(loadConfig(root)).rejects.toThrow(NaxError);
    });

    test(`the error names quality.${key} and how to get the behaviour`, async () => {
      const root = await writeProjectConfig({ quality: { [key]: false } });
      const err = (await loadConfig(root).catch((e: unknown) => e)) as NaxError;
      expect(err.message).toContain(`quality.${key}`);
      // The migration path is "unset the command", not "set another flag".
      expect(err.message).toContain("quality.commands");
    });
  }

  test("reports every dead flag at once rather than one per load", async () => {
    const root = await writeProjectConfig({
      quality: { requireTypecheck: false, requireLint: true, requireTests: false },
    });
    const err = (await loadConfig(root).catch((e: unknown) => e)) as NaxError;
    expect(err.message).toContain("quality.requireTypecheck");
    expect(err.message).toContain("quality.requireLint");
    expect(err.message).toContain("quality.requireTests");
  });

  test("carries a machine-readable code and the offending keys in context", async () => {
    const root = await writeProjectConfig({ quality: { requireLint: false } });
    const err = (await loadConfig(root).catch((e: unknown) => e)) as NaxError;
    expect(err.code).toBe("CONFIG_DEAD_QUALITY_FLAGS");
    expect(err.context?.deadKeys).toEqual(["quality.requireLint"]);
  });

  test("a config with no dead flags still loads", async () => {
    const root = await writeProjectConfig({ quality: { commands: { test: "bun test" } } });
    const config = await loadConfig(root);
    expect(config.quality?.commands?.test).toBe("bun test");
  });

  test("`true` is rejected too — the flag never did anything in either position", async () => {
    const root = await writeProjectConfig({ quality: { requireTests: true } });
    expect(loadConfig(root)).rejects.toThrow(NaxError);
  });
});
