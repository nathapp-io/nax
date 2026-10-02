import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import {
  ARROW_LABEL,
  buildStrictConfig,
  compareToBaseline,
  findSuppressions,
  labelAt,
  loadBaseline,
  parseScores,
  runBiome,
  tallyByFile,
} from "#scripts/check-complexity";

/** Each fake file holds one function per line, named after the line: `function f1() {}`, `function f2() {}`, … */
const readFake = (_file: string) => Array.from({ length: 9 }, (_, i) => `function f${i + 1}() {}`).join("\n");

/** A diagnostic whose span covers `f<line>` on that line of the fake file. */
const diag = (path: string, score: number, line = 1) => ({
  severity: "error",
  category: "lint/complexity/noExcessiveCognitiveComplexity",
  message: `Excessive complexity of ${score} detected (max: 20).`,
  location: { path, start: { line, column: 10 }, end: { line, column: 12 } },
});

const score = (file: string, value: number, label: string, line = 1) => ({
  file,
  score: value,
  label,
  line,
  column: 1,
});

describe("parseScores", () => {
  const report = (diagnostics: object[], errors = diagnostics.length) => ({
    summary: { errors, unchanged: 1 },
    diagnostics,
  });

  test("extracts one labelled score per complexity diagnostic", () => {
    expect(parseScores(report([diag("src/a.ts", 42), diag("src/b.ts", 21, 2)]), readFake)).toEqual([
      { file: "src/a.ts", score: 42, label: "f1", line: 1, column: 10 },
      { file: "src/b.ts", score: 21, label: "f2", line: 2, column: 10 },
    ]);
  });

  test("names the file when a function cannot be labelled", () => {
    const empty = {
      ...diag("src/odd.ts", 42),
      location: { path: "src/odd.ts", start: { line: 1, column: 3 }, end: { line: 1, column: 3 } },
    };

    expect(() => parseScores(report([empty]), readFake)).toThrow(/src\/odd\.ts/);
  });

  test("throws when a diagnostic has no span to label the function by", () => {
    const bare = { ...diag("src/a.ts", 42), location: { path: "src/a.ts" } };

    expect(() => parseScores(report([bare]), readFake)).toThrow(/score/);
  });

  test("throws when a complexity message no longer carries a score, instead of passing silently", () => {
    const bad = { ...diag("src/a.ts", 1), message: "Cognitive complexity too high." };

    expect(() => parseScores(report([bad]), readFake)).toThrow(/score/);
  });

  test("throws when the report has no diagnostics array", () => {
    expect(() => parseScores({ summary: { errors: 0 } })).toThrow(/diagnostics/);
  });

  test("ignores non-error notices from other categories", () => {
    const notice = { severity: "information", category: "deserialize", message: "recommended is deprecated" };

    expect(parseScores(report([diag("src/a.ts", 42), notice], 1), readFake)).toEqual([
      { file: "src/a.ts", score: 42, label: "f1", line: 1, column: 10 },
    ]);
  });

  test("throws when the report has no summary to confirm the run", () => {
    expect(() => parseScores({ diagnostics: [] })).toThrow(/summary/);
  });

  // A file biome could not parse or read yields a non-complexity error and no
  // complexity findings for that file; reading only the complexity rows would
  // under-count and could let a new violation through.
  test("throws when biome reported errors other than complexity findings", () => {
    const parseError = {
      severity: "error",
      category: "parse",
      message: "Expected an expression",
      location: { path: "src/x.ts" },
    };

    expect(() => parseScores(report([diag("src/a.ts", 42), parseError]), readFake)).toThrow(/parse/);
  });

  test("throws when the summary counts more errors than the diagnostics it printed", () => {
    expect(() => parseScores(report([diag("src/a.ts", 42)], 3), readFake)).toThrow(/3 errors/);
  });

  // An exclusion that matches the whole tree yields a clean, empty report —
  // indistinguishable from "no violations" unless the file count is checked (#2306).
  test("throws when biome scanned no files, instead of scoring an empty tree as clean", () => {
    const empty = { summary: { errors: 0, changed: 0, unchanged: 0 }, diagnostics: [] };

    expect(() => parseScores(empty, readFake)).toThrow(/scanned no files/);
  });

  test("throws when the summary carries no file counts to confirm anything was scanned", () => {
    expect(() => parseScores({ summary: { errors: 0 }, diagnostics: [] }, readFake)).toThrow(/scanned no files/);
  });
});

describe("labelAt", () => {
  const at = (source: string, line: number, from: number, to: number) =>
    labelAt(source, { line, column: from }, { line, column: to });

  test("returns the function name the span covers", () => {
    expect(at("export function runFixCycle() {}", 1, 17, 28)).toBe("runFixCycle");
  });

  test("returns the arrow label when the span covers an anonymous arrow's =>", () => {
    expect(at("items.map((item) => {", 1, 18, 21)).toBe(ARROW_LABEL);
  });

  test.each([
    ["a private method", "  #priv() {", 3, 8, "#priv"],
    ["a computed key", '  ["computed"]() {', 3, 15, '["computed"]'],
    ["a string-literal method name", '  "str-name"() {', 3, 13, '"str-name"'],
    ["an anonymous function expression", "export default function () {", 16, 24, "function"],
  ])("labels %s by the text its span covers, instead of crashing", (_what, source, from, to, label) => {
    expect(at(source, 1, from, to)).toBe(label);
  });

  // Biome's columns count code points; a UTF-16 slice would shift one unit per astral character.
  test("counts columns in code points, so an emoji earlier on the line does not shift the label", () => {
    expect(at('const s = "日本語😀"; function crlf() {}', 1, 28, 32)).toBe("crlf");
  });

  test("throws on an empty or multi-line span, instead of inventing a label", () => {
    expect(() => at("function f() {}", 1, 5, 5)).toThrow(/cannot label/);
    expect(() => labelAt("a\nb", { line: 1, column: 1 }, { line: 2, column: 2 })).toThrow(/cannot label/);
  });
});

describe("tallyByFile", () => {
  test("groups functions per file, highest first, with files in code-point order", () => {
    const byFile = tallyByFile([
      score("src/b.ts", 30, "low"),
      score("src/a.ts", 25, "only"),
      score("src/b.ts", 90, "high", 5),
    ]);

    expect(Object.keys(byFile)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(Object.entries(byFile["src/b.ts"] ?? {})).toEqual([
      ["high", 90],
      ["low", 30],
    ]);
  });

  test("numbers repeated labels in source order, not score order", () => {
    const byFile = tallyByFile([score("src/a.ts", 24, ARROW_LABEL, 9), score("src/a.ts", 50, ARROW_LABEL, 3)]);

    expect(byFile["src/a.ts"]).toEqual({ [ARROW_LABEL]: 50, [`${ARROW_LABEL}#2`]: 24 });
  });
});

describe("compareToBaseline", () => {
  test("a file matching its baseline exactly passes", () => {
    const result = compareToBaseline({ "src/a.ts": { a: 90, b: 30 } }, { "src/a.ts": { a: 90, b: 30 } });

    expect(result).toEqual({ added: [], grown: [], lowerable: [] });
  });

  test("a file absent from the baseline is a new violation", () => {
    const result = compareToBaseline({}, { "src/new.ts": { fresh: 21 } });

    expect(result.added).toEqual([{ file: "src/new.ts", scores: { fresh: 21 } }]);
  });

  test("a baselined function whose score rises is growth", () => {
    const result = compareToBaseline({ "src/a.ts": { a: 90, b: 30 } }, { "src/a.ts": { a: 90, b: 35 } });

    expect(result.grown).toEqual([{ file: "src/a.ts", scores: { a: 90, b: 35 }, baseline: { a: 90, b: 30 } }]);
  });

  test("a new over-limit function in a baselined file is growth, even if a sibling improved", () => {
    // Splitting a 165 into 100 + a 30-point helper: the helper is new code and must meet the limit.
    const result = compareToBaseline({ "src/a.ts": { big: 165 } }, { "src/a.ts": { big: 100, helper: 30 } });

    expect(result.grown).toHaveLength(1);
  });

  // REVIEW-complexity-drain.md §2.1: comparing by rank read both of these as "lowerable".
  test("one function rising while another falls is growth, not a lower", () => {
    const result = compareToBaseline({ "src/a.ts": { a: 80, b: 30 } }, { "src/a.ts": { a: 25, b: 79 } });

    expect(result.grown).toHaveLength(1);
    expect(result.lowerable).toEqual([]);
  });

  test("a new helper that fits under a fixed function's old score is still growth", () => {
    const result = compareToBaseline({ "src/a.ts": { a: 80, b: 30 } }, { "src/a.ts": { b: 30, helper: 30 } });

    expect(result.grown).toHaveLength(1);
    expect(result.lowerable).toEqual([]);
  });

  test("a baselined file that improved must be lowered, so the slack cannot be re-spent", () => {
    const result = compareToBaseline({ "src/a.ts": { a: 90, b: 30 } }, { "src/a.ts": { a: 80, b: 30 } });

    expect(result.grown).toEqual([]);
    expect(result.lowerable).toEqual(["src/a.ts"]);
  });

  test("a baselined function that dropped under the limit must be lowered", () => {
    const result = compareToBaseline({ "src/a.ts": { a: 90, b: 30 } }, { "src/a.ts": { a: 90 } });

    expect(result.lowerable).toEqual(["src/a.ts"]);
  });

  test("a baselined file with no remaining violations must be lowered", () => {
    const result = compareToBaseline({ "src/gone.ts": { a: 40 } }, {});

    expect(result.lowerable).toEqual(["src/gone.ts"]);
  });
});

describe("findSuppressions", () => {
  // Assembled at runtime so this test file does not itself trip the scan.
  const IGNORE = ["biome", "ignore"].join("-");

  test.each([
    ["the rule", `// ${IGNORE} lint/complexity/noExcessiveCognitiveComplexity: legacy`],
    ["the whole complexity group", `// ${IGNORE} lint/complexity: legacy`],
    ["every lint rule", `// ${IGNORE} lint: legacy`],
    ["the rule, file-wide", `// ${IGNORE}-all lint/complexity/noExcessiveCognitiveComplexity: legacy`],
    ["the rule, over a range", `// ${IGNORE}-start lint/complexity/noExcessiveCognitiveComplexity: legacy`],
    // Biome honours a list of rules in one comment; only checking the first one let this through.
    [
      "the rule, listed after another rule",
      `// ${IGNORE} lint/style/useConst lint/complexity/noExcessiveCognitiveComplexity: x`,
    ],
    ["the rule, in a block comment", `/* ${IGNORE} lint/complexity/noExcessiveCognitiveComplexity: legacy */`],
  ])("flags a suppression of %s", (_what, comment) => {
    expect(findSuppressions("src/x.ts", `const a = 1;\n${comment}\nfunction f() {}`)).toEqual(["src/x.ts:2"]);
  });

  test.each([
    ["another complexity rule", `// ${IGNORE} lint/complexity/useLiteralKeys: generated`],
    ["another group", `// ${IGNORE} lint/suspicious/noExplicitAny: fixture`],
    ["a formatter directive", `// ${IGNORE} format: table`],
    ["several other rules", `// ${IGNORE} lint/style/useConst lint/suspicious/noExplicitAny: fixture`],
  ])("ignores a suppression of %s", (_what, comment) => {
    expect(findSuppressions("src/x.ts", comment)).toEqual([]);
  });
});

describe("loadBaseline", () => {
  let dir: string;

  beforeAll(() => {
    dir = makeTempDir();
  });
  afterAll(() => cleanupTempDir(dir));

  test("returns null only when the file does not exist", () => {
    expect(loadBaseline(join(dir, "absent.json"))).toBeNull();
  });

  test("throws on a baseline in the old rank-ordered format instead of treating it as missing", () => {
    const path = join(dir, "old-format.json");
    writeFileSync(path, JSON.stringify({ byFile: { "src/a.ts": [90, 30] } }));

    expect(() => loadBaseline(path)).toThrow(/not a baseline/);
  });

  test("throws on a file that is not JSON", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json");

    expect(() => loadBaseline(path)).toThrow();
  });
});

describe("buildStrictConfig", () => {
  test("keeps only the complexity rule, at the strict limit", () => {
    const repoConfig = {
      files: { includes: ["**"] },
      plugins: ["./biome-plugins/no-as-never.grit"],
      linter: { rules: { complexity: { noExcessiveCognitiveComplexity: { level: "error" } } } },
    };

    const config = buildStrictConfig(repoConfig, 20);

    expect(config).not.toHaveProperty("plugins");
    expect(config.linter.rules).toEqual({
      recommended: false,
      complexity: { noExcessiveCognitiveComplexity: { level: "error", options: { maxAllowedComplexity: 20 } } },
    });
  });

  // From a --config-path outside the repo, Biome matches `!` patterns against
  // the absolute path, so a worktree exclusion drops every file of a checkout
  // that itself lives in a worktree directory (#2306).
  test("drops the repo's path exclusions and keeps its includes", () => {
    const repoConfig = { files: { includes: ["**", "!**/.worktrees/**", "!**/.nax-wt/**", "src/**"] } };

    expect(buildStrictConfig(repoConfig, 20).files).toEqual({ includes: ["**", "src/**"] });
  });

  test("includes everything when the repo config declares no includes", () => {
    expect(buildStrictConfig({}, 20).files).toEqual({ includes: ["**"] });
  });
});

/**
 * The real repo config, scanned from a checkout that lives inside each kind of
 * worktree directory the repo excludes. Every one must still be measured.
 */
describe("runBiome from a checkout inside a worktree directory", () => {
  /** Seven nested ifs: cognitive complexity 1+2+…+7 = 28, over STRICT_LIMIT. */
  const DEEP = `export function deep(a: number): number {
  if (a > 0) {
    if (a > 1) {
      if (a > 2) {
        if (a > 3) {
          if (a > 4) {
            if (a > 5) {
              if (a > 6) return 7;
            }
          }
        }
      }
    }
  }
  return a;
}
`;
  let dir: string;

  beforeAll(() => {
    dir = makeTempDir();
  });
  afterAll(() => cleanupTempDir(dir));

  test.each([
    [".worktrees", ["fix-x"]],
    [".claude/worktrees", ["fix-x"]],
    [".nax-wt", ["story-feature-US-001"]],
  ])(
    "scores an over-limit function in a checkout under %s/",
    (worktreeDir, [name]) => {
      const root = join(dir, worktreeDir, name ?? "");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "deep.ts"), DEEP);

      const scores = runBiome(root, ["src/"]);

      expect(scores).toEqual([{ file: "src/deep.ts", score: 28, label: "deep", line: 1, column: 17 }]);
    },
    30_000,
  );
});
