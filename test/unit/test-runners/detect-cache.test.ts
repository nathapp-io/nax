/**
 * Unit tests for the detect module — cache behaviour
 *
 * Extracted from detect.test.ts to keep both files under the 400-line limit.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DetectionResult } from "../../../src/test-runners/detect";
import { _cacheDeps } from "../../../src/test-runners/detect/cache";
import { _directoryScanDeps } from "../../../src/test-runners/detect/directory-scan";
import { _fileScanDeps } from "../../../src/test-runners/detect/file-scan";
import { _frameworkConfigDeps } from "../../../src/test-runners/detect/framework-configs";
import { _frameworkDefaultsDeps } from "../../../src/test-runners/detect/framework-defaults";
import { detectTestFilePatterns } from "../../../src/test-runners/detect/index";

type Orig = {
  readText: typeof _frameworkConfigDeps.readText;
  parseToml: typeof _frameworkConfigDeps.parseToml;
  parseYaml: typeof _frameworkConfigDeps.parseYaml;
  defaultsReadText: typeof _frameworkDefaultsDeps.readText;
  defaultsFileExists: typeof _frameworkDefaultsDeps.fileExists;
  fileScanSpawn: typeof _fileScanDeps.spawn;
  cacheReadJson: typeof _cacheDeps.readJson;
  cacheWriteJson: typeof _cacheDeps.writeJson;
  cacheFileMtime: typeof _cacheDeps.fileMtime;
  dirExists: typeof _directoryScanDeps.dirExists;
  dirSpawn: typeof _directoryScanDeps.spawn;
};

let orig: Orig;

function spawnWithOutput(output: string): ReturnType<typeof Bun.spawn> {
  const enc = new TextEncoder();
  const bytes = enc.encode(output);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { exited: Promise.resolve(0), stdout: stream } as unknown as ReturnType<typeof Bun.spawn>;
}

beforeEach(() => {
  orig = {
    readText: _frameworkConfigDeps.readText,
    parseToml: _frameworkConfigDeps.parseToml,
    parseYaml: _frameworkConfigDeps.parseYaml,
    defaultsReadText: _frameworkDefaultsDeps.readText,
    defaultsFileExists: _frameworkDefaultsDeps.fileExists,
    fileScanSpawn: _fileScanDeps.spawn,
    cacheReadJson: _cacheDeps.readJson,
    cacheWriteJson: _cacheDeps.writeJson,
    cacheFileMtime: _cacheDeps.fileMtime,
    dirExists: _directoryScanDeps.dirExists,
    dirSpawn: _directoryScanDeps.spawn,
  };
  _cacheDeps.readJson = mock(async () => { throw new Error("not found"); });
  _cacheDeps.writeJson = mock(async () => {});
  _cacheDeps.fileMtime = mock(async () => null);
  _directoryScanDeps.dirExists = mock(async () => false);
  _directoryScanDeps.spawn = mock((..._args: unknown[]) =>
    ({ exited: Promise.resolve(1), stdout: null } as unknown as ReturnType<typeof Bun.spawn>),
  ) as unknown as typeof Bun.spawn;
  _frameworkDefaultsDeps.fileExists = mock(async () => false);
});

afterEach(() => {
  _frameworkConfigDeps.readText = orig.readText;
  _frameworkConfigDeps.parseToml = orig.parseToml;
  _frameworkConfigDeps.parseYaml = orig.parseYaml;
  _frameworkDefaultsDeps.readText = orig.defaultsReadText;
  _frameworkDefaultsDeps.fileExists = orig.defaultsFileExists;
  _fileScanDeps.spawn = orig.fileScanSpawn;
  _cacheDeps.readJson = orig.cacheReadJson;
  _cacheDeps.writeJson = orig.cacheWriteJson;
  _cacheDeps.fileMtime = orig.cacheFileMtime;
  _directoryScanDeps.dirExists = orig.dirExists;
  _directoryScanDeps.spawn = orig.dirSpawn;
});

describe("cache", () => {
  test("returns cached result on hit", async () => {
    const cached: DetectionResult = {
      patterns: ["**/*.cached.ts"],
      confidence: "high",
      sources: [
        { type: "framework-config", path: "/fake/workdir/vitest.config.ts", patterns: ["**/*.cached.ts"] },
      ],
    };

    _cacheDeps.readJson = mock(async () => ({
      workdir: "/fake/workdir",
      mtimes: {},
      result: cached,
    }));
    _cacheDeps.fileMtime = mock(async () => null);

    const readTextSpy = mock(async () => null);
    _frameworkConfigDeps.readText = readTextSpy;
    _frameworkDefaultsDeps.readText = readTextSpy;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).toEqual(["**/*.cached.ts"]);
    expect(readTextSpy).not.toHaveBeenCalled();
  });

  test("writes result to cache after detection", async () => {
    _cacheDeps.readJson = mock(async () => { throw new Error("miss"); });
    _cacheDeps.fileMtime = mock(async () => null);

    const written: Array<[string, unknown]> = [];
    _cacheDeps.writeJson = mock(async (path: string, data: unknown) => {
      written.push([path, data]);
    });

    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    await detectTestFilePatterns("/fake/workdir");
    expect(written.length).toBe(1);
    expect(written[0]?.[0]).toContain("test-patterns.json");
  });

  test("treats corrupt cache as miss, rebuilds without throwing", async () => {
    _cacheDeps.readJson = mock(async () => { throw new SyntaxError("bad json"); });
    _cacheDeps.fileMtime = mock(async () => null);
    _cacheDeps.writeJson = mock(async () => {});

    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;
    _directoryScanDeps.dirExists = mock(async () => false);

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("empty");
  });

  test("invalidates cache when mtime changes", async () => {
    const cached: DetectionResult = {
      patterns: ["**/*.stale.ts"],
      confidence: "high",
      sources: [],
    };

    _cacheDeps.readJson = mock(async () => ({
      workdir: "/fake/workdir",
      mtimes: { "package.json": 100 },
      result: cached,
    }));
    _cacheDeps.fileMtime = mock(async (path: string) => {
      if (path.endsWith("package.json")) return 200; // changed
      return null;
    });
    _cacheDeps.writeJson = mock(async () => {});

    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      return null;
    });
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).not.toContain("**/*.stale.ts");
    expect(result.confidence).toBe("medium");
  });
});
