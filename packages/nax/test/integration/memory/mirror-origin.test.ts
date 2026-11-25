/**
 * mirror-origin.test.ts — a memory host records the mirror's origin as it composes.
 *
 * Covers US-020 AC-4, AC-23 and AC-24 at the `createMemoryHost` entry point: an enabled host
 * writes the origin once, into the project directory it resolved, naming the repository root
 * it was given; a mirror whose disk refuses the write still yields a usable host; and a
 * disabled host writes nothing at all, because it resolves no directories either.
 *
 * The origin's own writing rules are unit-tested in `test/unit/memory/mirror-origin.test.ts`.
 * These cases drive the real composition (a real mirror directory, the real store, the real
 * local provider) and only count what the file seam was asked to write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertDefined, cleanupTempDir, type MockLogger, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { _mirrorOriginDeps, createMemoryHost, memoryDirs, ORIGIN_FILE } from "@/memory";

describe("createMemoryHost records the mirror origin", () => {
  let globalDir: string;
  let repoRoot: string;
  let logger: MockLogger;
  let savedGlobalEnv: string | undefined;
  let originalDeps: typeof _mirrorOriginDeps;
  /** Every origin file the seam was asked to write, in call order. */
  let writes: { readonly path: string; readonly text: string }[];

  /** Count the origin writes while still writing them, as the mirror's own disk would. */
  function countWrites(): void {
    _mirrorOriginDeps.writeFile = async (path, text) => {
      writes.push({ path, text });
      await originalDeps.writeFile(path, text);
    };
  }

  /** The origin the host resolved for this repository, as the JSON file holds it. */
  function recordedOrigin(projectDir: string): unknown {
    return JSON.parse(readFileSync(join(projectDir, ORIGIN_FILE), "utf8"));
  }

  beforeEach(() => {
    globalDir = makeTempDir("nax-origin-host-global-");
    repoRoot = makeTempDir("nax-origin-host-repo-");
    logger = makeLogger();
    writes = [];
    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    originalDeps = { ..._mirrorOriginDeps };
  });

  afterEach(() => {
    Object.assign(_mirrorOriginDeps, originalDeps);
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    cleanupTempDir(globalDir);
    cleanupTempDir(repoRoot);
  });

  test("AC-4 writes the origin once, into the mirror the host resolved, naming the repo root", async () => {
    countWrites();
    const dirs = await memoryDirs({ config: makeNaxConfig(), repoRoot });

    const host = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });

    assertDefined(host, "the memory host");
    const canonicalRoot = await realpath(repoRoot);
    expect({ dirs: host.dirs.projectDir, writes: writes.map((write) => write.path) }).toEqual({
      dirs: dirs.projectDir,
      writes: [join(dirs.projectDir, ORIGIN_FILE)],
    });
    expect(recordedOrigin(dirs.projectDir)).toEqual({ root: canonicalRoot, name: basename(canonicalRoot) });
  });

  test("AC-23 returns a usable host when the mirror will not take the origin", async () => {
    _mirrorOriginDeps.writeFile = async () => {
      throw new Error("EROFS: read-only file system");
    };

    const host = await createMemoryHost({ config: makeNaxConfig(), repoRoot, source: "nax-chat", logger });

    assertDefined(host, "the memory host");
    expect({ provider: host.providerId, notes: await host.notes("project") }).toEqual({
      provider: "local",
      notes: [],
    });
  });

  test("AC-24 writes no origin for a disabled host, and returns null", async () => {
    countWrites();

    const host = await createMemoryHost({
      config: makeNaxConfig({ memory: { enabled: false } }),
      repoRoot,
      source: "nax-chat",
      logger,
    });

    expect({ host, writes: writes.length }).toEqual({ host: null, writes: 0 });
  });
});
