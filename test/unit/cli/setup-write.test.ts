/**
 * Tests for writeSetupConfig (src/cli/setup-write.ts)
 *
 * All deps are injected via the `deps` parameter — no real filesystem I/O.
 * mirror: src/cli/setup-write.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { _writeSetupDeps, writeSetupConfig } from "@/cli";
import { DEFAULT_CONFIG } from "@/config";
import type { MonoPackageConfig } from "@/operations/setup-generate";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKDIR = "/fake/workdir";
const NAX_DIR = join(WORKDIR, ".nax");
const ROOT_CONFIG_PATH = join(NAX_DIR, "config.json");
const BASE_CONFIG = DEFAULT_CONFIG;

const NO_MONO: MonoPackageConfig[] = [];

const MONO_CONFIGS: MonoPackageConfig[] = [
  { relativeDir: "packages/a", config: {} },
  { relativeDir: "packages/b", config: { quality: { language: "go" } } },
];

// ─── Save / restore _writeSetupDeps ──────────────────────────────────────────

type WriteDeps = typeof _writeSetupDeps;
let savedDeps: WriteDeps;

beforeEach(() => {
  savedDeps = { ..._writeSetupDeps };
});

afterEach(() => {
  Object.assign(_writeSetupDeps, savedDeps);
});

// ─── Helper: build a fake deps object ────────────────────────────────────────

function makeFakeDeps() {
  const writtenFiles: Array<{ path: string; content: string }> = [];
  const createdDirs: string[] = [];

  const deps: WriteDeps = {
    writeFile: mock(async (path: string, content: string) => {
      writtenFiles.push({ path, content });
    }),
    mkdir: mock(async (path: string) => {
      createdDirs.push(path);
    }),
  };

  return { deps, writtenFiles, createdDirs };
}

// ─── AC1: single-package — only root config.json written ─────────────────────

describe("writeSetupConfig — AC1: single-package writes only root config", () => {
  test("AC1: writes exactly one file when monoConfigs is empty", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, NO_MONO, undefined, deps);
    expect(writtenFiles).toHaveLength(1);
  });

  test("AC1 boundary: the written file path is .nax/config.json", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, NO_MONO, undefined, deps);
    expect(writtenFiles[0]?.path).toBe(ROOT_CONFIG_PATH);
  });

  test("AC1 boundary: written content is valid JSON matching the config", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, NO_MONO, undefined, deps);
    const parsed = JSON.parse(writtenFiles[0]?.content ?? "null");
    expect(parsed).toEqual(BASE_CONFIG);
  });
});

// ─── AC2: single-package — mkdir called for .nax dir ─────────────────────────

describe("writeSetupConfig — AC2: single-package calls mkdir for .nax", () => {
  test("AC2: calls mkdir with .nax path", async () => {
    const { deps, createdDirs } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, NO_MONO, undefined, deps);
    expect(createdDirs).toContain(NAX_DIR);
  });

  test("AC2 boundary: mkdir is called before writeFile", async () => {
    const callOrder: string[] = [];
    const deps: WriteDeps = {
      mkdir: mock(async () => {
        callOrder.push("mkdir");
      }),
      writeFile: mock(async () => {
        callOrder.push("writeFile");
      }),
    };
    await writeSetupConfig(WORKDIR, BASE_CONFIG, NO_MONO, undefined, deps);
    expect(callOrder.indexOf("mkdir")).toBeLessThan(callOrder.indexOf("writeFile"));
  });
});

// ─── AC3: multi-package — root + each mono config written ────────────────────

describe("writeSetupConfig — AC3: multi-package writes root and each mono config", () => {
  test("AC3: writes root config plus one file per mono package", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    expect(writtenFiles).toHaveLength(1 + MONO_CONFIGS.length);
  });

  test("AC3 boundary: root config is written first", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    expect(writtenFiles[0]?.path).toBe(ROOT_CONFIG_PATH);
  });

  test("AC3 boundary: each mono config is written at .nax/mono/<relativeDir>/config.json", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    const monoFiles = writtenFiles.slice(1);
    expect(monoFiles[0]?.path).toBe(join(NAX_DIR, "mono", "packages/a", "config.json"));
    expect(monoFiles[1]?.path).toBe(join(NAX_DIR, "mono", "packages/b", "config.json"));
  });

  test("AC3 boundary: mono config content matches each MonoPackageConfig.config", async () => {
    const { deps, writtenFiles } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    const monoFiles = writtenFiles.slice(1);
    expect(JSON.parse(monoFiles[0]?.content ?? "null")).toEqual(MONO_CONFIGS[0]?.config);
    expect(JSON.parse(monoFiles[1]?.content ?? "null")).toEqual(MONO_CONFIGS[1]?.config);
  });
});

// ─── AC4: multi-package — mkdir called for each mono dir ─────────────────────

describe("writeSetupConfig — AC4: multi-package calls mkdir for each mono dir", () => {
  test("AC4: calls mkdir for .nax and each .nax/mono/<relativeDir>", async () => {
    const { deps, createdDirs } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    expect(createdDirs).toContain(NAX_DIR);
    expect(createdDirs).toContain(join(NAX_DIR, "mono", "packages/a"));
    expect(createdDirs).toContain(join(NAX_DIR, "mono", "packages/b"));
  });

  test("AC4 boundary: total mkdir call count equals 1 + number of mono packages", async () => {
    const { deps, createdDirs } = makeFakeDeps();
    await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    expect(createdDirs).toHaveLength(1 + MONO_CONFIGS.length);
  });
});

// ─── AC5: returned written[] paths are correct and ordered ───────────────────

describe("writeSetupConfig — AC5: returned written[] is ordered (root first, then mono)", () => {
  test("AC5: returns root config path for single-package", async () => {
    const { deps } = makeFakeDeps();
    const result = await writeSetupConfig(WORKDIR, BASE_CONFIG, NO_MONO, undefined, deps);
    expect(result.written).toEqual([ROOT_CONFIG_PATH]);
  });

  test("AC5 boundary: returns root + mono paths in order for multi-package", async () => {
    const { deps } = makeFakeDeps();
    const result = await writeSetupConfig(WORKDIR, BASE_CONFIG, MONO_CONFIGS, undefined, deps);
    expect(result.written).toEqual([
      ROOT_CONFIG_PATH,
      join(NAX_DIR, "mono", "packages/a", "config.json"),
      join(NAX_DIR, "mono", "packages/b", "config.json"),
    ]);
  });
});
