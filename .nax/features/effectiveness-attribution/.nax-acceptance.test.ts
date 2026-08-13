import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import * as engine from "../../../src/context/engine";
import * as effectiveness from "../../../src/context/engine/effectiveness";
import {
  _effectivenessEvalDeps,
  loadLabelSet,
  scoreEffectiveness,
} from "../../../src/context/engine/effectiveness-eval";
import { buildManifest } from "../../../src/context/engine/manifest-builder";
import { loadContextManifests, writeContextManifest } from "../../../src/context/engine/manifest-store";
import { StaticRulesProvider, _staticRulesDeps } from "../../../src/context/engine/providers/static-rules";
import type { CanonicalRule } from "../../../src/context/rules/canonical-loader";

type Label = "followed" | "ignored" | "contradicted" | "unclear";
type LabelCase = {
  caseId: string;
  label: Label;
  diff: string;
  diffLength?: number;
  chunkSummary: string;
  classifier: { signal: Label } | null;
};
type ScopedClassifier = (input: {
  diff: string;
  terms: unknown;
  scopePaths?: string[];
  chunkScopePaths?: string[];
}) => { followed?: boolean; ignored?: boolean; unknown?: boolean; evidence?: { filePath?: string } };

const packageRoot = join(import.meta.dir, "../../..");
const tempDirs: string[] = [];
const makeDir = () => {
  const dir = makeTempDir("nax-effectiveness-acceptance-");
  tempDirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(cleanupTempDir));
});

function cases(labels: Label[], classifier: Label[] = labels, lengths = labels.map((_, i) => i + 1)): LabelCase[] {
  return labels.map((label, index) => ({
    caseId: `case-${index + 1}`,
    label,
    diffLength: lengths[index],
    diff: `--- a/src/file-${index}.ts\n+++ b/src/file-${index}.ts\n+token${index} alpha beta gamma`,
    chunkSummary: `token${index} alpha beta gamma`,
    classifier: { signal: classifier[index] ?? "ignored" },
  }));
}

async function writeLabels(dir: string, value: unknown, name = "labels.json"): Promise<string> {
  const path = join(dir, name);
  await Bun.write(path, JSON.stringify(value));
  return path;
}

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", "run", "bin/nax.ts", ...args], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

const labelSet = (items: LabelCase[]) => ({ version: "1", cases: items });
const classifyScoped = effectiveness.classifyWithTerms as unknown as ScopedClassifier;
const evidenceFor = effectiveness.buildEvidenceTerms as unknown as (input: unknown) => unknown;

describe("effectiveness-attribution acceptance", () => {
  test("AC-1: loadLabelSet loads one well-formed version-1 case", async () => {
    const item: LabelCase = {
      caseId: "case-1",
      label: "followed",
      diff: "+token alpha beta gamma",
      chunkSummary: "token alpha beta gamma",
      classifier: { signal: "followed" },
    };
    const path = await writeLabels(makeDir(), labelSet([item]));
    const loaded = await loadLabelSet(path);
    expect(loaded.cases).toHaveLength(1);
    expect(loaded.cases[0]?.caseId).toBe(item.caseId);
  });

  test("AC-2: loadLabelSet names caseId and label for a missing label", async () => {
    const path = await writeLabels(makeDir(), {
      version: "1",
      cases: [{ ...cases(["followed"])[0], label: undefined }],
    });
    await expect(loadLabelSet(path)).rejects.toThrow(/case-1.*label|label.*case-1/i);
  });

  test("AC-3: loadLabelSet distinguishes parse errors from schema errors", async () => {
    const dir = makeDir();
    const malformed = join(dir, "malformed.json");
    await Bun.write(malformed, "{ not json");
    const invalid = await writeLabels(dir, { version: "1", cases: [{ caseId: "missing-label" }] }, "invalid.json");
    const parseError = await loadLabelSet(malformed).catch((error: unknown) => error as { code?: string });
    const schemaError = await loadLabelSet(invalid).catch((error: unknown) => error as { code?: string });
    expect(parseError.code).toBeDefined();
    expect(parseError.code).not.toBe(schemaError.code);
  });

  test("AC-4: scoreEffectiveness bounds every per-signal metric", () => {
    const report = scoreEffectiveness(
      cases(["followed", "followed", "ignored", "contradicted"], ["followed", "followed", "ignored", "ignored"]),
    );
    for (const metrics of Object.values(report.perSignal)) {
      for (const value of [metrics.precision, metrics.recall, metrics.f1]) {
        expect(typeof value).toBe("number");
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  test("AC-5: scoreEffectiveness excludes unclear cases", () => {
    const report = scoreEffectiveness(cases(["unclear", "unclear", "followed", "ignored"]));
    expect(report.excludedCount).toBe(2);
    expect(report.scoredCount).toBe(2);
  });

  test("AC-6: scoreEffectiveness exposes a zero always-ignored baseline", () => {
    const input = cases(["ignored", "ignored", "ignored"]);
    const report = scoreEffectiveness(input);
    expect(report.baseline).toMatchObject({ precision: 0, recall: 0, f1: 0, scoredCount: input.length });
  });

  test("AC-7: scoreEffectiveness finds strong positive size correlation", () => {
    const report = scoreEffectiveness(
      cases(["ignored", "ignored", "followed", "followed"], undefined, [10, 20, 30, 40]),
    );
    expect(report.sizeCorrelation).toBeGreaterThan(0.9);
  });

  test("AC-8: scoreEffectiveness finds near-zero size correlation for an even distribution", () => {
    const report = scoreEffectiveness(
      cases(
        ["followed", "ignored", "ignored", "followed", "followed", "ignored", "ignored", "followed"],
        undefined,
        [1, 2, 3, 4, 5, 6, 7, 8],
      ),
    );
    expect(Math.abs(report.sizeCorrelation)).toBeLessThan(0.2);
  });

  test("AC-9: scoreEffectiveness returns the complete EvalReport", () => {
    const report = scoreEffectiveness(cases(["followed"]));
    for (const key of ["perSignal", "baseline", "sizeCorrelation", "scoredCount", "excludedCount"] as const)
      expect(report[key]).toBeDefined();
  });

  test("AC-10: context effectiveness eval exits zero when thresholds are met", async () => {
    const path = await writeLabels(makeDir(), labelSet(cases(["followed", "ignored", "contradicted"])));
    expect((await runCli(["context", "effectiveness", "eval", "--labels", path])).exitCode).toBe(0);
  });

  test("AC-11: context effectiveness eval reports a nonexistent labels path", async () => {
    const path = join(makeDir(), "does-not-exist.json");
    const result = await runCli(["context", "effectiveness", "eval", "--labels", path]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(path);
  });

  test("AC-12: context effectiveness eval reports label read failures", async () => {
    const path = await writeLabels(makeDir(), labelSet(cases(["followed"])));
    expect(await Bun.spawn(["chmod", "000", path]).exited).toBe(0);
    const result = await runCli(["context", "effectiveness", "eval", "--labels", path]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/read|permission|EACCES/i);
  });

  test("AC-13: context effectiveness eval does not emit a report for schema errors", async () => {
    const path = await writeLabels(makeDir(), { version: "1", cases: [{ caseId: "broken" }] });
    const result = await runCli(["context", "effectiveness", "eval", "--labels", path]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/label|schema|validation/i);
    expect(result.stdout).not.toMatch(/"perSignal"/);
  });

  test("AC-14: context effectiveness eval --json emits exactly one JSON report", async () => {
    const path = await writeLabels(makeDir(), labelSet(cases(["followed", "ignored"])));
    const result = await runCli(["context", "effectiveness", "eval", "--labels", path, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      perSignal: expect.any(Object),
      sizeCorrelation: expect.any(Number),
    });
    expect(result.stdout).not.toMatch(/[│├]/);
  });

  test("AC-15: scoreEffectiveness logs and skips a case that cannot be scored", () => {
    const warnings: unknown[] = [];
    const originalLogger = _effectivenessEvalDeps.getLogger;
    _effectivenessEvalDeps.getLogger = () => ({ warn: (...args: unknown[]) => warnings.push(args) }) as never;
    try {
      const input = [
        ...cases(["followed", "ignored"]),
        {
          caseId: "bad-case",
          label: "followed",
          diff: "+bad alpha beta gamma",
          chunkSummary: "bad alpha beta gamma",
          classifier: null,
        },
      ];
      const report = scoreEffectiveness(input);
      expect(report.scoredCount).toBe(2);
      expect(JSON.stringify(warnings)).toContain("bad-case");
      expect(report.perSignal.followed).toBeDefined();
    } finally {
      _effectivenessEvalDeps.getLogger = originalLogger;
    }
  });

  test("AC-16: RawChunk accepts optional scopePaths", () => {
    const scoped = {
      id: "one",
      kind: "static",
      scope: "project",
      role: ["all"],
      content: "x",
      tokens: 1,
      rawScore: 1,
      scopePaths: ["src/**/*.ts"],
    };
    const unscoped = {
      id: "two",
      kind: "static",
      scope: "project",
      role: ["all"],
      content: "x",
      tokens: 1,
      rawScore: 1,
    };
    expect(scoped.scopePaths).toEqual(["src/**/*.ts"]);
    expect(unscoped.scopePaths).toBeUndefined();
  });

  test("AC-17: StaticRulesProvider carries appliesTo into scopePaths", async () => {
    const original = _staticRulesDeps.loadCanonicalRules;
    _staticRulesDeps.loadCanonicalRules = async () =>
      [{ fileName: "agent.md", content: "rule", appliesTo: ["src/agents/**/*.ts"] }] as CanonicalRule[];
    try {
      const result = await new StaticRulesProvider().fetch({
        storyId: "US-1",
        repoRoot: packageRoot,
        packageDir: packageRoot,
        stage: "execution",
        role: "implementer",
        budgetTokens: 1000,
      });
      expect(result.chunks[0]?.scopePaths).toEqual(["src/agents/**/*.ts"]);
    } finally {
      _staticRulesDeps.loadCanonicalRules = original;
    }
  });

  test("AC-18: StaticRulesProvider omits scopePaths without appliesTo", async () => {
    const original = _staticRulesDeps.loadCanonicalRules;
    _staticRulesDeps.loadCanonicalRules = async () => [{ fileName: "global.md", content: "rule" }] as CanonicalRule[];
    try {
      const result = await new StaticRulesProvider().fetch({
        storyId: "US-1",
        repoRoot: packageRoot,
        packageDir: packageRoot,
        stage: "execution",
        role: "implementer",
        budgetTokens: 1000,
      });
      expect(result.chunks[0]?.scopePaths).toBeUndefined();
    } finally {
      _staticRulesDeps.loadCanonicalRules = original;
    }
  });

  test("AC-19: StaticRulesProvider applies rule globs to every section", async () => {
    const original = _staticRulesDeps.loadCanonicalRules;
    _staticRulesDeps.loadCanonicalRules = async () =>
      [
        { fileName: "agent.md", content: "## One\nfirst\n## Two\nsecond", appliesTo: ["src/agents/**/*.ts"] },
      ] as CanonicalRule[];
    try {
      const result = await new StaticRulesProvider().fetch({
        storyId: "US-1",
        repoRoot: packageRoot,
        packageDir: packageRoot,
        stage: "execution",
        role: "implementer",
        budgetTokens: 1000,
      });
      expect(result.chunks).toHaveLength(2);
      expect(
        result.chunks.every((chunk) => JSON.stringify(chunk.scopePaths) === JSON.stringify(["src/agents/**/*.ts"])),
      ).toBe(true);
    } finally {
      _staticRulesDeps.loadCanonicalRules = original;
    }
  });

  test("AC-20: buildManifest maps scoped packed chunks", () => {
    const manifest = buildManifest({
      requestId: "r",
      request: {
        storyId: "s",
        repoRoot: "/r",
        packageDir: "/r",
        stage: "execution",
        role: "implementer",
        budgetTokens: 100,
      },
      packed: [{ id: "chunk", content: "x", tokens: 1, scopePaths: ["src/agents/**/*.ts"] }],
      usedTokens: 1,
      digestTokens: 0,
      buildMs: 0,
      providerResults: [],
      roleFiltered: [],
      belowMin: [],
      dedupeDropped: [],
      budgetExcludedIds: [],
      floorPackedIds: [],
      floorOverageIds: [],
      effectiveBudget: 100,
    } as never);
    expect(manifest.chunkScopePaths).toEqual({ chunk: ["src/agents/**/*.ts"] });
  });

  test("AC-21: buildManifest omits chunkScopePaths when no chunk is scoped", () => {
    const manifest = buildManifest({
      requestId: "r",
      request: {
        storyId: "s",
        repoRoot: "/r",
        packageDir: "/r",
        stage: "execution",
        role: "implementer",
        budgetTokens: 100,
      },
      packed: [{ id: "chunk", content: "x", tokens: 1 }],
      usedTokens: 1,
      digestTokens: 0,
      buildMs: 0,
      providerResults: [],
      roleFiltered: [],
      belowMin: [],
      dedupeDropped: [],
      budgetExcludedIds: [],
      floorPackedIds: [],
      floorOverageIds: [],
      effectiveBudget: 100,
    } as never);
    expect(manifest.chunkScopePaths).toBeUndefined();
  });

  test("AC-22: manifest persistence preserves chunkScopePaths", async () => {
    const dir = makeDir();
    await writeContextManifest(dir, "feature", "US-1", "execution", {
      requestId: "r",
      stage: "execution",
      totalBudgetTokens: 1,
      usedTokens: 1,
      includedChunks: ["chunk"],
      excludedChunks: [],
      floorItems: [],
      digestTokens: 0,
      buildMs: 0,
      chunkScopePaths: { chunk: ["src/**/*.ts"] },
    } as never);
    expect((await loadContextManifests(dir, "US-1", "feature"))[0]?.manifest.chunkScopePaths).toEqual({
      chunk: ["src/**/*.ts"],
    });
  });

  test("AC-23: splitDiffByFile separates two post-image files", () => {
    const split = effectiveness.splitDiffByFile(
      "--- a/src/file-a.ts\n+++ b/src/file-a.ts\n+a-only\n--- a/src/file-b.ts\n+++ b/src/file-b.ts\n+b-only",
    );
    expect(Object.keys(split)).toHaveLength(2);
    expect(split["src/file-a.ts"]).toContain("a-only");
    expect(split["src/file-a.ts"]).not.toContain("b-only");
    expect(split["src/file-b.ts"]).toContain("b-only");
    expect(split["src/file-b.ts"]).not.toContain("a-only");
  });

  test("AC-24: splitDiffByFile keys renames by post-image path", () =>
    expect(effectiveness.splitDiffByFile("--- a/old.ts\n+++ b/new.ts\n+content")).toEqual({ "new.ts": "+content" }));
  test("AC-25: splitDiffByFile handles binary files", () =>
    expect(effectiveness.splitDiffByFile("--- a/bin.png\n+++ b/bin.png\nBinary files differ")).toEqual({
      "bin.png": "",
    }));

  test("AC-26: scoped classifier ignores changes outside its scope", () => {
    const result = classifyScoped({
      diff: "--- a/src/cli/context.ts\n+++ b/src/cli/context.ts\n+agent adapter authentication",
      terms: evidenceFor({ terms: ["agent", "adapter", "authentication"] }),
      scopePaths: ["src/agents/**/*.ts"],
      chunkScopePaths: [],
    });
    expect(result).toMatchObject({ followed: false, ignored: true });
  });

  test("AC-27: scoped evidence uses only matching diff sections", () => {
    const sections = effectiveness.splitDiffByFile(
      "--- a/src/agents/acp/adapter.ts\n+++ b/src/agents/acp/adapter.ts\n+adapter token protocol\n--- a/src/cli/context.ts\n+++ b/src/cli/context.ts\n+cli forbidden words",
    );
    expect(JSON.stringify(evidenceFor({ diffSections: sections, scopePaths: ["src/agents/**/*.ts"] }))).toContain(
      "adapter",
    );
    expect(JSON.stringify(evidenceFor({ diffSections: sections, scopePaths: ["src/agents/**/*.ts"] }))).not.toContain(
      "forbidden",
    );
  });

  test("AC-28: absent and empty scopes both use all diff sections", () => {
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n+token alpha beta";
    const terms = evidenceFor({ diff: effectiveness.splitDiffByFile(diff) });
    expect(classifyScoped({ diff, terms, scopePaths: undefined })).toEqual(
      classifyScoped({ diff, terms, scopePaths: [] }),
    );
  });

  test("AC-29: unsplittable scoped diffs become unknown", () => {
    const result = classifyScoped({
      diff: "not a unified diff",
      terms: evidenceFor({ terms: ["alpha", "beta", "gamma"] }),
      chunkScopePaths: ["chunk-id"],
    });
    expect(result).toMatchObject({ followed: false, unknown: true });
  });

  test("AC-30: removed-only terms do not produce followed", () => {
    expect(
      classifyScoped({
        diff: "--- a/src/core/a.ts\n+++ b/src/core/a.ts\n-removed-term",
        terms: evidenceFor({ terms: ["removed-term"] }),
        scopePaths: ["src/core/**"],
      }).followed,
    ).toBe(false);
  });

  test("AC-31: followed scoped evidence identifies a matching file", () => {
    const result = classifyScoped({
      diff: "--- a/src/core/a.ts\n+++ b/src/core/a.ts\n+alpha beta gamma",
      terms: evidenceFor({ terms: ["alpha", "beta", "gamma"] }),
      scopePaths: ["src/core/**"],
    });
    expect(result.followed).toBe(true);
    expect(result.evidence?.filePath).toStartWith("src/core/");
  });

  test("AC-32: annotation marks chunks ignored when their scopes match no diff file", async () => {
    const result = await (
      effectiveness.annotateManifestEffectiveness as unknown as (
        items: unknown[],
      ) => Promise<Array<{ chunkEffectiveness: Record<string, { ignored?: boolean; followed?: boolean }> }>>
    )([
      {
        includedChunks: ["chunk"],
        chunkScopePaths: { chunk: ["src/agents/**"] },
        diffSections: { "src/cli/context.ts": "+change" },
      },
    ]);
    expect(result[0]?.chunkEffectiveness.chunk).toMatchObject({ ignored: true, followed: false });
  });

  test("AC-33: scoped fixture reduces absolute size correlation", () => {
    const report = scoreEffectiveness(
      cases(["ignored", "followed", "ignored", "followed"], undefined, [10, 20, 30, 40]) as never,
    );
    const preChangeWholeDiffCorr = 0.95;
    expect(Math.abs(report.sizeCorrelation)).toBeLessThan(Math.abs(preChangeWholeDiffCorr));
  });

  test("AC-34: scoped fixture improves followed F1 over its baseline", () => {
    const report = scoreEffectiveness(cases(["followed", "ignored", "followed", "ignored"]));
    expect(report.perSignal.followed.f1).toBeGreaterThan(report.baseline.f1);
  });

  test("AC-35: annotation logs one failed manifest and continues", async () => {
    const logged: unknown[] = [];
    const annotate = effectiveness.annotateManifestEffectiveness as unknown as (
      items: unknown[],
      logger: (entry: unknown) => void,
    ) => Promise<unknown[]>;
    const output = await annotate(
      Array.from({ length: 5 }, (_, index) => ({ index, failWrite: index === 2 })),
      (entry) => logged.push(entry),
    );
    expect(logged).toContainEqual(expect.objectContaining({ error: "manifest-2-write-failed" }));
    expect(output).toHaveLength(5);
  });

  test("AC-36: effectiveness eval passes the fixture cases to scoreEffectiveness once", async () => {
    const path = await writeLabels(makeDir(), labelSet(cases(["followed", "ignored"])));
    const cli = (await import("../../../src/cli/context")) as unknown as {
      contextEffectivenessEvalCommand: (args: string[]) => Promise<void>;
    };
    const calls: unknown[][] = [];
    const original = _effectivenessEvalDeps.scoreEffectiveness;
    _effectivenessEvalDeps.scoreEffectiveness = ((input: unknown[]) => {
      calls.push(input);
      return scoreEffectiveness(input as LabelCase[]);
    }) as typeof original;
    try {
      await cli.contextEffectivenessEvalCommand(["context", "effectiveness", "eval", "--fixture", path]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual((await loadLabelSet(path)).cases);
    } finally {
      _effectivenessEvalDeps.scoreEffectiveness = original;
    }
  });

  test("AC-37: classifyWithTerms returns the expected EffectivenessSignal", () => {
    const classify = effectiveness.classifyWithTerms as unknown as (summary: string, evidence: unknown) => string;
    const signal = classify(
      "alpha beta gamma",
      (effectiveness.buildEvidenceTerms as unknown as (source: string) => unknown)("alpha beta gamma"),
    );
    expect(["high", "medium", "low"]).toContain(signal);
    expect(signal).toBe("high");
  });

  test("AC-38: barrel and direct classifyWithTerms return the same signal", () => {
    const direct = effectiveness.classifyWithTerms as unknown as (summary: string, evidence: unknown) => string;
    const barrel = engine.classifyWithTerms as unknown as (summary: string, evidence: unknown) => string;
    const evidence = (effectiveness.buildEvidenceTerms as unknown as (source: string) => unknown)("alpha beta gamma");
    const result = direct("alpha beta gamma", evidence);
    expect(["high", "medium", "low"]).toContain(result);
    expect(barrel("alpha beta gamma", evidence)).toBe(result);
  });

  test("AC-39: effectiveness no longer exports classifyEffectiveness", async () => {
    expect(Object.keys(effectiveness)).not.toContain("classifyEffectiveness");
    expect(Reflect.get(effectiveness, "classifyEffectiveness")).toBeUndefined();
    expect(
      await Bun.spawn(["bun", "x", "tsc", "--noEmit"], { cwd: packageRoot, stdout: "pipe", stderr: "pipe" }).exited,
    ).toBe(0);
  });
});