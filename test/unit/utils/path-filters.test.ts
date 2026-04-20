import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _pathFilterDeps,
  buildNaxIgnoreIndex,
  filterNaxInternalPaths,
  isNaxInternalPath,
  resolveNaxIgnorePatterns,
} from "../../../src/utils/path-filters";

describe("path-filters (#542)", () => {
  let origFileExists: typeof _pathFilterDeps.fileExists;
  let origReadFile: typeof _pathFilterDeps.readFile;

  beforeEach(() => {
    origFileExists = _pathFilterDeps.fileExists;
    origReadFile = _pathFilterDeps.readFile;
  });

  afterEach(() => {
    _pathFilterDeps.fileExists = origFileExists;
    _pathFilterDeps.readFile = origReadFile;
  });

  describe("isNaxInternalPath", () => {
    test.each([
      [".nax/cache/test-patterns.json", true],
      [".nax/features/foo/prd.json", true],
      [".nax/features/foo/sessions/sess-x/descriptor.json", true],
      [".nax/prompt-audit/foo/bar.txt", true],
      [".nax/status.json", true],
      ["fixtures/tdd-calc/.nax/status.json", true],
      ["packages/web/.nax/mono/packages/web/config.json", true],
      ["nax.lock", true],
      ["packages/web/nax.lock", true],
      ["bun.lock", true],
      ["bun.lockb", true],
      ["fixtures/tdd-calc/bun.lock", true],
      ["package-lock.json", true],
      ["yarn.lock", true],
      ["pnpm-lock.yaml", true],
      ["go.sum", true],
      ["Cargo.lock", true],
      ["poetry.lock", true],
      ["uv.lock", true],
      ["Pipfile.lock", true],
      ["composer.lock", true],
      ["Gemfile.lock", true],
      ["packages/api/go.sum", true],
      ["src/calc.ts", false],
      ["src/calc.test.ts", false],
      ["test/unit/foo.test.ts", false],
      ["package.json", false],
      ["docs/foo.md", false],
      ["script/nax-runner.sh", false],
    ])("%s → %s", (path, expected) => {
      expect(isNaxInternalPath(path)).toBe(expected);
    });
  });

  describe("filterNaxInternalPaths", () => {
    test("preserves user paths, drops nax-internal", () => {
      const input = [
        ".nax/cache/test-patterns.json",
        "src/calc.ts",
        "fixtures/tdd-calc/.nax/status.json",
        "src/calc.test.ts",
        "nax.lock",
        "package.json",
      ];
      expect(filterNaxInternalPaths(input)).toEqual(["src/calc.ts", "src/calc.test.ts", "package.json"]);
    });

    test("empty input → empty output", () => {
      expect(filterNaxInternalPaths([])).toEqual([]);
    });

    test("all-internal input → empty output", () => {
      expect(filterNaxInternalPaths([".nax/status.json", "nax.lock"])).toEqual([]);
    });

    test("does not mutate input", () => {
      const input = [".nax/status.json", "src/foo.ts"];
      const snapshot = [...input];
      filterNaxInternalPaths(input);
      expect(input).toEqual(snapshot);
    });

    test("drops files matching resolved .naxignore patterns", async () => {
      const files = new Map<string, string>([
        ["/repo/.naxignore", "*.generated.ts\ncoverage/\n"],
      ]);
      _pathFilterDeps.fileExists = async (path) => files.has(path);
      _pathFilterDeps.readFile = async (path) => files.get(path) ?? "";

      const matchers = await resolveNaxIgnorePatterns("/repo");
      const input = ["src/app.ts", "src/types.generated.ts", "coverage/lcov.info"];
      expect(filterNaxInternalPaths(input, matchers)).toEqual(["src/app.ts"]);
    });
  });

  describe("resolveNaxIgnorePatterns (#550)", () => {
    test("loads root patterns and ignores comments/blank lines", async () => {
      const files = new Map<string, string>([
        ["/repo/.naxignore", "# comment\n\n*.generated.ts\nlocales/en.json\n"],
      ]);
      _pathFilterDeps.fileExists = async (path) => files.has(path);
      _pathFilterDeps.readFile = async (path) => files.get(path) ?? "";

      const matchers = await resolveNaxIgnorePatterns("/repo");
      expect(matchers).toHaveLength(2);
      expect(matchers.every((m) => m.source === "root")).toBe(true);
      expect(matchers.some((m) => m.test("src/foo.generated.ts"))).toBe(true);
      expect(matchers.some((m) => m.test("locales/en.json"))).toBe(true);
    });

    test("merges root then package patterns for monorepo package", async () => {
      const files = new Map<string, string>([
        ["/repo/.naxignore", "*.generated.ts\n"],
        ["/repo/packages/web/.naxignore", "dist/\nassets/tmp/**\n"],
      ]);
      _pathFilterDeps.fileExists = async (path) => files.has(path);
      _pathFilterDeps.readFile = async (path) => files.get(path) ?? "";

      const matchers = await resolveNaxIgnorePatterns("/repo", "/repo/packages/web");
      expect(matchers).toHaveLength(3);
      expect(matchers[0]?.source).toBe("root");
      expect(matchers[1]?.source).toBe("package");
      expect(matchers[2]?.source).toBe("package");
      expect(matchers.some((m) => m.test("src/foo.generated.ts"))).toBe(true);
      expect(matchers.some((m) => m.test("dist/index.js"))).toBe(true);
    });

    test("allows root patterns with package prefixes to match package-relative paths", async () => {
      const files = new Map<string, string>([
        ["/repo/.naxignore", "packages/web/locales/en.json\n"],
      ]);
      _pathFilterDeps.fileExists = async (path) => files.has(path);
      _pathFilterDeps.readFile = async (path) => files.get(path) ?? "";

      const matchers = await resolveNaxIgnorePatterns("/repo", "/repo/packages/web");
      expect(matchers).toHaveLength(1);
      expect(matchers[0]?.test("locales/en.json")).toBe(true);
    });
  });

  describe("buildNaxIgnoreIndex", () => {
    test("pre-resolves repo-root and package matchers", async () => {
      const files = new Map<string, string>([
        ["/repo/.naxignore", "*.generated.ts\n"],
        ["/repo/packages/web/.naxignore", "dist/\n"],
      ]);
      _pathFilterDeps.fileExists = async (path) => files.has(path);
      _pathFilterDeps.readFile = async (path) => files.get(path) ?? "";

      const index = await buildNaxIgnoreIndex("/repo", ["/repo/packages/web"]);
      expect(index.getMatchers()).toHaveLength(1);
      expect(index.getMatchers("/repo/packages/web")).toHaveLength(2);
      expect(index.filter(["src/foo.generated.ts", "src/main.ts"], "/repo/packages/web")).toEqual(["src/main.ts"]);
      expect(index.filter(["dist/app.js", "src/main.ts"], "/repo/packages/web")).toEqual(["src/main.ts"]);
    });

    test("returns root matchers for unknown package dir", async () => {
      const files = new Map<string, string>([["/repo/.naxignore", "*.generated.ts\n"]]);
      _pathFilterDeps.fileExists = async (path) => files.has(path);
      _pathFilterDeps.readFile = async (path) => files.get(path) ?? "";

      const index = await buildNaxIgnoreIndex("/repo", []);
      expect(index.filter(["src/foo.generated.ts", "src/main.ts"], "/repo/packages/unknown")).toEqual(["src/main.ts"]);
      expect(index.toPathspecExcludes()).toEqual([":!*.generated.ts"]);
    });
  });
});
