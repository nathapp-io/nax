import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildStrictConfig, compareToBaseline, parseScores, tallyByFile } from "@scripts/check-complexity";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

const diag = (path: string, score: number) => ({
  severity: "error",
  category: "lint/complexity/noExcessiveCognitiveComplexity",
  message: `Excessive complexity of ${score} detected (max: 20).`,
  location: { path },
});

describe("parseScores", () => {
  const report = (diagnostics: object[], errors = diagnostics.length) => ({ summary: { errors }, diagnostics });

  test("extracts one score per complexity diagnostic", () => {
    expect(parseScores(report([diag("src/a.ts", 42), diag("src/b.ts", 21)]))).toEqual([
      { file: "src/a.ts", score: 42 },
      { file: "src/b.ts", score: 21 },
    ]);
  });

  test("throws when a complexity message no longer carries a score, instead of passing silently", () => {
    const bad = { ...diag("src/a.ts", 1), message: "Cognitive complexity too high." };

    expect(() => parseScores(report([bad]))).toThrow(/score/);
  });

  test("throws when the report has no diagnostics array", () => {
    expect(() => parseScores({ summary: { errors: 0 } })).toThrow(/diagnostics/);
  });

  test("ignores non-error notices from other categories", () => {
    const notice = { severity: "information", category: "deserialize", message: "recommended is deprecated" };

    expect(parseScores(report([diag("src/a.ts", 42), notice], 1))).toEqual([{ file: "src/a.ts", score: 42 }]);
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

    expect(() => parseScores(report([diag("src/a.ts", 42), parseError]))).toThrow(/parse/);
  });

  test("throws when the summary counts more errors than the diagnostics it printed", () => {
    expect(() => parseScores(report([diag("src/a.ts", 42)], 3))).toThrow(/3 errors/);
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

/**
 * End to end: the real script against the real tree, with a fixture baseline
 * derived from the committed one. Pins the exit codes and the refusal to raise,
 * which the pure functions above cannot see.
 */
describe("check-complexity script", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const SCRIPT = join(REPO, "scripts", "check-complexity.ts");
  const committed: { byFile: Record<string, number[]> } = JSON.parse(
    readFileSync(join(REPO, "scripts", "baselines", "complexity-baseline.json"), "utf8"),
  );
  const [probeFile, probeScores] = Object.entries(committed.byFile)[0] ?? ["", []];
  const worst = probeScores[0] ?? 0;
  let dir: string;

  beforeAll(() => {
    dir = makeTempDir();
  });
  afterAll(() => cleanupTempDir(dir));

  /** Writes a baseline where `probeFile`'s worst score is replaced by `score`. */
  function fixture(name: string, score: number): string {
    const path = join(dir, name);
    const byFile = { ...committed.byFile, [probeFile]: [score, ...probeScores.slice(1)] };
    writeFileSync(path, JSON.stringify({ ...committed, byFile }));
    return path;
  }

  async function run(...args: string[]) {
    const proc = Bun.spawn(["bun", SCRIPT, ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { exitCode: await proc.exited, stdout, stderr };
  }

  test("passes against a baseline that matches the tree", async () => {
    const result = await run(`--baseline=${fixture("match.json", worst)}`);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  test("fails when a function scores higher than its baseline", async () => {
    const result = await run(`--baseline=${fixture("grown.json", worst - 1)}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ratchet breached");
    expect(result.stderr).toContain(probeFile);
  }, 30_000);

  test("fails when the baseline is looser than the tree, so the slack cannot be re-spent", async () => {
    const result = await run(`--baseline=${fixture("stale.json", worst + 1)}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("baseline is stale");
  }, 30_000);

  test("--update-baseline refuses to raise a baseline and leaves the file untouched", async () => {
    const path = fixture("refuse.json", worst - 1);
    const before = readFileSync(path, "utf8");

    const result = await run(`--baseline=${path}`, "--update-baseline");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only ever goes down");
    expect(readFileSync(path, "utf8")).toBe(before);
  }, 30_000);

  test("fails when the baseline file is missing", async () => {
    const result = await run(`--baseline=${join(dir, "absent.json")}`);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing or unreadable");
  }, 30_000);
});
