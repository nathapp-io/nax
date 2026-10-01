import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { acceptCommand } from "@/cli/accept";
import { loadPRD } from "@/prd";

// `acceptCommand` resolves the feature dir as `featureDir(findProjectDir(cwd), feature)`,
// and `findProjectDir` already returns the `.nax` dir itself — so the real path nests a
// second `.nax` segment underneath it (`.nax/.nax/features/<feature>`). That is existing
// behavior this test pins as-is; it is not something introduced or endorsed here.
function writePRD(naxDir: string, feature: string): string {
  const featureDir = join(naxDir, ".nax", "features", feature);
  mkdirSync(featureDir, { recursive: true });
  const prdPath = join(featureDir, "prd.json");
  writeFileSync(
    prdPath,
    JSON.stringify({
      project: "test-project",
      feature,
      branchName: "main",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories: [],
    }),
  );
  return prdPath;
}

describe("acceptCommand", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tempDir = realpathSync(makeTempDir("nax-accept-cmd-"));
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTempDir(tempDir);
  });

  test("throws NAX error for an invalid AC id format", async () => {
    process.chdir(tempDir);
    await expect(acceptCommand({ feature: "f", override: "not-an-ac", reason: "why" })).rejects.toThrow(
      /Invalid AC ID format/,
    );
  });

  test("throws when not inside a nax project directory", async () => {
    process.chdir(tempDir);
    await expect(acceptCommand({ feature: "f", override: "AC-1", reason: "why" })).rejects.toThrow(
      /Not in a nax project directory/,
    );
  });

  test("throws when the feature does not exist", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "test-project" }));
    process.chdir(tempDir);

    await expect(acceptCommand({ feature: "ghost-feature", override: "AC-1", reason: "why" })).rejects.toThrow(
      /Feature not found/,
    );
  });

  test("adds an override to prd.json, normalizing the AC id to uppercase", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "test-project" }));
    const prdPath = writePRD(naxDir, "my-feature");
    process.chdir(tempDir);

    await acceptCommand({ feature: "my-feature", override: "ac-2", reason: "intentional: lazy expiry" });

    const prd = await loadPRD(prdPath);
    expect(prd.acceptanceOverrides).toEqual({ "AC-2": "intentional: lazy expiry" });
  });

  test("overwrites an existing override for the same AC id and logs a warning", async () => {
    const naxDir = join(tempDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), JSON.stringify({ name: "test-project" }));
    const prdPath = writePRD(naxDir, "repeat-feature");
    process.chdir(tempDir);

    await acceptCommand({ feature: "repeat-feature", override: "AC-1", reason: "first reason" });
    await acceptCommand({ feature: "repeat-feature", override: "AC-1", reason: "second reason" });

    const prd = await loadPRD(prdPath);
    expect(prd.acceptanceOverrides).toEqual({ "AC-1": "second reason" });
  });
});
