import { describe, expect, test } from "bun:test";
import { filterNaxInternalPaths, isNaxInternalPath } from "../../../src/utils/path-filters";

describe("path-filters (#542)", () => {
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
  });
});
