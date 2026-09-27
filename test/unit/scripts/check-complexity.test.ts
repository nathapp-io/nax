import { describe, expect, test } from "bun:test";
import { buildStrictConfig, compareToBaseline, parseScores, tallyByFile } from "@scripts/check-complexity";

const diag = (path: string, score: number) => ({
  category: "lint/complexity/noExcessiveCognitiveComplexity",
  message: `Excessive complexity of ${score} detected (max: 20).`,
  location: { path },
});

describe("parseScores", () => {
  test("extracts one score per complexity diagnostic", () => {
    const report = { diagnostics: [diag("src/a.ts", 42), diag("src/b.ts", 21)] };

    expect(parseScores(report)).toEqual([
      { file: "src/a.ts", score: 42 },
      { file: "src/b.ts", score: 21 },
    ]);
  });

  test("ignores diagnostics from other rules", () => {
    const report = { diagnostics: [{ category: "lint/suspicious/noConsole", message: "x", location: { path: "a" } }] };

    expect(parseScores(report)).toEqual([]);
  });

  test("throws when a complexity message no longer carries a score, instead of passing silently", () => {
    const report = {
      diagnostics: [{ ...diag("src/a.ts", 1), message: "Cognitive complexity too high." }],
    };

    expect(() => parseScores(report)).toThrow(/score/);
  });

  test("throws when the report has no diagnostics array", () => {
    expect(() => parseScores({})).toThrow(/diagnostics/);
  });
});

describe("tallyByFile", () => {
  test("groups scores per file, highest first, with files in code-point order", () => {
    const byFile = tallyByFile([
      { file: "src/b.ts", score: 30 },
      { file: "src/a.ts", score: 25 },
      { file: "src/b.ts", score: 90 },
    ]);

    expect(Object.keys(byFile)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(byFile["src/b.ts"]).toEqual([90, 30]);
  });
});

describe("compareToBaseline", () => {
  test("a file matching its baseline exactly passes", () => {
    const result = compareToBaseline({ "src/a.ts": [90, 30] }, { "src/a.ts": [90, 30] });

    expect(result).toEqual({ added: [], grown: [], lowerable: [] });
  });

  test("a file absent from the baseline is a new violation", () => {
    const result = compareToBaseline({}, { "src/new.ts": [21] });

    expect(result.added).toEqual([{ file: "src/new.ts", scores: [21] }]);
  });

  test("a baselined function whose score rises is growth", () => {
    const result = compareToBaseline({ "src/a.ts": [90, 30] }, { "src/a.ts": [90, 35] });

    expect(result.grown).toEqual([{ file: "src/a.ts", scores: [90, 35], baseline: [90, 30] }]);
  });

  test("a new over-limit function in a baselined file is growth, even if a sibling improved", () => {
    // Splitting a 165 into 100 + a 30-point helper: the helper is new code and must meet the limit.
    const result = compareToBaseline({ "src/a.ts": [165] }, { "src/a.ts": [100, 30] });

    expect(result.grown).toHaveLength(1);
  });

  test("a baselined file that improved must be lowered, so the slack cannot be re-spent", () => {
    const result = compareToBaseline({ "src/a.ts": [90, 30] }, { "src/a.ts": [80, 30] });

    expect(result.grown).toEqual([]);
    expect(result.lowerable).toEqual(["src/a.ts"]);
  });

  test("a baselined file with no remaining violations must be lowered", () => {
    const result = compareToBaseline({ "src/gone.ts": [40] }, {});

    expect(result.lowerable).toEqual(["src/gone.ts"]);
  });
});

describe("buildStrictConfig", () => {
  test("keeps only the complexity rule, at the strict limit, and preserves the file includes", () => {
    const repoConfig = {
      files: { includes: ["**", "!**/.worktrees/**"] },
      plugins: ["./biome-plugins/no-as-never.grit"],
      linter: { rules: { complexity: { noExcessiveCognitiveComplexity: { level: "error" } } } },
    };

    const config = buildStrictConfig(repoConfig, 20);

    expect(config.files).toEqual(repoConfig.files);
    expect(config).not.toHaveProperty("plugins");
    expect(config.linter.rules).toEqual({
      recommended: false,
      complexity: { noExcessiveCognitiveComplexity: { level: "error", options: { maxAllowedComplexity: 20 } } },
    });
  });
});
