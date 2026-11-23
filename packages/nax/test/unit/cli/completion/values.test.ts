/**
 * Unit tests for the completion value sources (US-001).
 *
 * Every fixture is a real isolated directory: a project is `.nax/config.json`
 * plus whatever the test needs beside it, and the global config directory is
 * redirected through NAX_GLOBAL_CONFIG_DIR (restored afterwards) so no test
 * touches the developer's real home.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { listFeatureNames, listProfileNames } from "@/cli/completion";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Writes `content` to `path`, creating every missing parent directory. */
async function writeFileAt(path: string, content = "{}\n"): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

/** Turns `root` into a nax project: `<root>/.nax/config.json`. */
async function makeProject(root: string): Promise<void> {
  await writeFileAt(join(root, ".nax", "config.json"));
}

/** Creates the feature directories named in `names` under `<root>/.nax/features`. */
function makeFeatures(root: string, names: readonly string[]): void {
  for (const name of names) {
    mkdirSync(join(root, ".nax", "features", name), { recursive: true });
  }
}

/** Creates `<root>/.nax/features/{alpha,beta}` — the fixture AC-1..AC-3 share. */
async function makeAlphaBetaProject(root: string): Promise<void> {
  await makeProject(root);
  makeFeatures(root, ["beta", "alpha"]);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let projectDir: string;
let globalDir: string;
let origGlobalDir: string | undefined;

beforeEach(() => {
  projectDir = makeTempDir("nax-completion-values-");
  globalDir = makeTempDir("nax-completion-global-");
  origGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
});

afterEach(() => {
  cleanupTempDir(projectDir);
  cleanupTempDir(globalDir);
  if (origGlobalDir === undefined) {
    delete process.env.NAX_GLOBAL_CONFIG_DIR;
  } else {
    process.env.NAX_GLOBAL_CONFIG_DIR = origGlobalDir;
  }
});

// ─── listFeatureNames ─────────────────────────────────────────────────────────

describe("listFeatureNames", () => {
  test("AC-1: resolves the sorted feature directory names of the enclosing project", async () => {
    await makeAlphaBetaProject(projectDir);

    expect(await listFeatureNames(projectDir)).toEqual(["alpha", "beta"]);
  });

  test("AC-2: resolves the same names when called from a nested subdirectory of the project", async () => {
    await makeAlphaBetaProject(projectDir);
    const deep = join(projectDir, "src", "deep");
    mkdirSync(deep, { recursive: true });

    expect(await listFeatureNames(deep)).toEqual(["alpha", "beta"]);
  });

  test("AC-3: skips a regular file and a dot-directory beside the feature directories", async () => {
    await makeAlphaBetaProject(projectDir);
    await writeFileAt(join(projectDir, ".nax", "features", "notes.md"), "# notes\n");
    mkdirSync(join(projectDir, ".nax", "features", ".cache"), { recursive: true });

    expect(await listFeatureNames(projectDir)).toEqual(["alpha", "beta"]);
  });

  test("AC-4: resolves [] when no .nax/config.json exists in startDir or any ancestor", async () => {
    // projectDir stays a bare temp directory, and its ancestors are the OS temp
    // tree — never a nax project.
    expect(await listFeatureNames(projectDir)).toEqual([]);
  });

  test("AC-5: resolves [] for a project with no .nax/features directory", async () => {
    await makeProject(projectDir);

    expect(await listFeatureNames(projectDir)).toEqual([]);
  });

  test("AC-11: keeps only names validateFeatureName accepts, so a hostile directory is never offered", async () => {
    await makeAlphaBetaProject(projectDir);
    mkdirSync(join(projectDir, ".nax", "features", "x;touch pwned"), { recursive: true });

    expect(await listFeatureNames(projectDir)).toEqual(["alpha", "beta"]);
  });
});

// ─── listProfileNames ─────────────────────────────────────────────────────────

describe("listProfileNames", () => {
  /** Global g1/shared plus project p1/shared — the fixture AC-6..AC-7 share. */
  async function makeProfileFixtures(): Promise<void> {
    await writeFileAt(join(globalDir, "profiles", "g1.json"));
    await writeFileAt(join(globalDir, "profiles", "shared.json"));
    await makeProject(projectDir);
    await writeFileAt(join(projectDir, ".nax", "profiles", "p1.json"));
    await writeFileAt(join(projectDir, ".nax", "profiles", "shared.json"));
  }

  test("AC-6: merges global and project profile names, de-duplicated and sorted", async () => {
    await makeProfileFixtures();

    expect(await listProfileNames(projectDir)).toEqual(["g1", "p1", "shared"]);
  });

  test("AC-7: ignores a non-.json file in the global profiles directory", async () => {
    await makeProfileFixtures();
    await writeFileAt(join(globalDir, "profiles", "g1.env"), "FAST_MODEL=x\n");

    expect(await listProfileNames(projectDir)).toEqual(["g1", "p1", "shared"]);
  });

  test("AC-8: resolves only the global names when startDir is outside any nax project", async () => {
    await writeFileAt(join(globalDir, "profiles", "g1.json"));
    await writeFileAt(join(globalDir, "profiles", "shared.json"));

    // projectDir is a bare temp directory: no project root, so only the
    // (redirected) global profiles are found.
    expect(await listProfileNames(projectDir)).toEqual(["g1", "shared"]);
  });

  test("AC-9: resolves the merged names when called from a nested subdirectory of the project", async () => {
    await makeProfileFixtures();
    const deep = join(projectDir, "src", "deep");
    mkdirSync(deep, { recursive: true });

    expect(await listProfileNames(deep)).toEqual(["g1", "p1", "shared"]);
  });

  test("AC-10: resolves project profiles only when the global profiles directory is missing", async () => {
    await makeProject(projectDir);
    await writeFileAt(join(projectDir, ".nax", "profiles", "p1.json"));
    await writeFileAt(join(projectDir, ".nax", "profiles", "shared.json"));
    // globalDir exists but carries no profiles/ directory.

    expect(await listProfileNames(projectDir)).toEqual(["p1", "shared"]);
  });

  test("AC-12: drops profile names a shell could act on", async () => {
    await makeProfileFixtures();
    await writeFileAt(join(projectDir, ".nax", "profiles", "bad name$x.json"));

    expect(await listProfileNames(projectDir)).toEqual(["g1", "p1", "shared"]);
  });
});
