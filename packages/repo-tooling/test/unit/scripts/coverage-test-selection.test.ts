import { describe, expect, test } from "bun:test";
import { coverageTestPaths, isSourceFreeTest } from "#scripts/coverage-test-selection";

const HEADER = 'import { describe, expect, test } from "bun:test";\nimport { join } from "node:path";';

describe("isSourceFreeTest", () => {
  test("a file that only spawns the CLI, with bun:test, node: and temp-dir helpers, is source-free", () => {
    const text = [
      HEADER,
      'import { mkdirSync } from "node:fs";',
      'import { cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";',
      'const proc = Bun.spawn(["bun", join(import.meta.dir, "../../bin/nax.ts")]);',
    ].join("\n");
    expect(isSourceFreeTest(text)).toBe(true);
  });

  test("a file with no imports beyond bun:test is source-free", () => {
    expect(isSourceFreeTest('import { test } from "bun:test";\ntest("x", () => {});')).toBe(true);
  });

  test("a multi-line safe helper import is source-free", () => {
    expect(isSourceFreeTest(`${HEADER}\nimport {\n  cleanupTempDir,\n  makeTempDir,\n} from "@test/helpers";`)).toBe(
      true,
    );
  });

  test("a multi-line helper import naming one unsafe helper keeps the file", () => {
    expect(isSourceFreeTest(`${HEADER}\nimport {\n  makeTempDir,\n  runLink,\n} from "@test/helpers";`)).toBe(false);
  });

  test("import text in a comment cannot hide a real unsafe import after it", () => {
    expect(isSourceFreeTest(`${HEADER}\n// import x from here\nimport { run } from "./harness";`)).toBe(false);
  });

  test.each(['export * from "../helpers/harness";', 'export { harness } from "./harness";'])(
    "a re-export (%s) loads a module, so it keeps the file",
    (line) => {
      expect(isSourceFreeTest(`${HEADER}\n${line}`)).toBe(false);
    },
  );

  test.each([
    ['import { run } from "@/cli/run";', "an @/ import"],
    ['import { run } from "../../src/cli/run";', "a relative src/ import"],
    ['import { runLink } from "@test/helpers";', "a helper that may run src/ in-process"],
    ['import { makeTempDir, runLink } from "@test/helpers";', "any non-temp-dir helper among them"],
    ['import { harness } from "./harness";', "a relative test module"],
    ['import { evalLabels } from "@scripts/command-safety-eval";', "a script module"],
    ['import { createSession } from "@nathapp/nax-agent";', "a package import"],
    ['import "@test/helpers/setup";', "a side-effect import"],
    ["const m = await import('node:fs');", "a dynamic import"],
    ['const m = require("node:fs");', "a require"],
    ['mock.module("@/config", () => ({}));', "an @/ module mock"],
  ])("%s keeps the file (%s)", (line) => {
    expect(isSourceFreeTest(`${HEADER}\n${line}`)).toBe(false);
  });

  test.each(["NAX_TEST_CONFINED", "NAX_SANDBOXED", "NAX_SANDBOX_REQUIRED"])(
    "a file that reads %s is kept: it behaves differently outside the sandbox",
    (name) => {
      expect(isSourceFreeTest(`${HEADER}\nif (process.env.${name}) test.skip("x", () => {});`)).toBe(false);
    },
  );
});

describe("coverageTestPaths", () => {
  const files: Record<string, string> = {
    "test/unit/a.test.ts": `${HEADER}\nimport { a } from "@/a";`,
    "test/unit/cli/spawn.test.ts": `${HEADER}\nimport { makeTempDir } from "@test/helpers";`,
    "test/integration/b.test.ts": `${HEADER}\nimport { b } from "@/b";`,
    "test/integration/cli/doctor.test.ts": HEADER,
    "test/ui/chat/keys.test.tsx": `${HEADER}\nimport { render } from "ink-testing-library";`,
  };
  const deps = {
    listTestFiles: (_root: string, suite: string) => Object.keys(files).filter((f) => f.startsWith(suite)),
    read: (path: string) => files[path.slice("/pkg/".length)] ?? "",
  };

  test("lists unit and integration files by path, minus the source-free ones", () => {
    const { paths, skipped } = coverageTestPaths("/pkg", ["test/unit/", "test/integration/", "test/ui/"], deps);
    expect(paths).toEqual(["./test/unit/a.test.ts", "./test/integration/b.test.ts", "test/ui/"]);
    expect(skipped).toEqual(["test/unit/cli/spawn.test.ts", "test/integration/cli/doctor.test.ts"]);
  });

  test("keeps test/ui/ whole: the confined step never runs it, so this run is its only run", () => {
    const { paths } = coverageTestPaths("/pkg", ["test/ui/"], deps);
    expect(paths).toEqual(["test/ui/"]);
  });

  test("a suite with no source-free file still runs every file", () => {
    const { paths, skipped } = coverageTestPaths("/pkg", ["test/unit/"], {
      ...deps,
      listTestFiles: () => ["test/unit/a.test.ts"],
    });
    expect(paths).toEqual(["./test/unit/a.test.ts"]);
    expect(skipped).toEqual([]);
  });
});
