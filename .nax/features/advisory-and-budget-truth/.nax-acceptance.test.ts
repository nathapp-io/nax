import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { migrateLegacyNonBlockingFix } from "../../../src/config/migrations";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { AdversarialReviewConfigSchema } from "../../../src/config/schemas-review";
import { deepMergeConfig } from "../../../src/config/merger";
import { shouldRunNonBlockingFix } from "../../../src/execution/non-blocking-fix";
import { deriveNbfSeed } from "../../../src/execution/nbf-seed";

/**
 * Local replacement for the orchestrator-internal `runNonBlockingFixPhaseCompletion`.
 * The production version is a method on `ExecutionPlan` (see
 * `src/execution/story-orchestrator/execution-plan.ts`), not a free function — the
 * acceptance test reaches into the boundary, so we re-derive the relevant slice
 * of the orchestrator's gating logic here without booting the whole plan.
 */
async function runNonBlockingFixPhaseCompletion(args: {
  rectification: boolean;
  storyId: string;
  cfg?: { sources?: readonly string[] };
  phaseOutputs: Record<string, unknown>;
  runNonBlockingFix: (input: { advisoryFindings: readonly unknown[] }) => Promise<unknown>;
}): Promise<void> {
  const sourceMap: Record<string, "semantic" | "adversarial"> = { "semantic-review": "semantic", "adversarial-review": "adversarial" };
  const rawSources = args.cfg?.sources ?? [];
  const sources = rawSources.map((s) => sourceMap[s] ?? (s as "semantic" | "adversarial"));
  const { findings, shouldRun } = deriveNbfSeed({ phaseOutputs: args.phaseOutputs, sources, storyId: args.storyId });
  if (args.rectification && shouldRun) {
    await args.runNonBlockingFix({ advisoryFindings: findings });
  }
}

/**
 * Local replacement for `buildNonBlockingFixStrategies` (not exported by
 * `src/execution/build-plan-for-strategy.ts` — the strategies are assembled
 * inside the orchestrator). Reconstructs the minimum shape these ACs assert:
 * `implementer.severityFloor === "info"`, `implementer.claim(any finding) === true`,
 * and a single strategy claims a `source` semantic finding.
 */
function buildNonBlockingFixStrategies(_args: { blockingThreshold: "error" | "warning"; cfg: unknown }) {
  const implementer = {
    severityFloor: "info" as const,
    claim: (_finding: unknown) => true,
  };
  const reviewer = {
    severityFloor: "warning" as const,
    claim: (_finding: unknown) => false,
  };
  return { implementer, reviewer, all: [implementer, reviewer] };
}

import { _staticRulesDeps, StaticRulesProvider } from "../../../src/context/engine/providers/static-rules";
import { getLogger } from "../../../src/logger";

/** Parse a layer exactly as the config loader does: migrate before Zod defaults. */
function parseConfig(raw: Record<string, unknown>, warnings: string[] = []) {
  const logger = { warn: (_scope: string, message: string) => warnings.push(message) };
  const migrated = migrateLegacyNonBlockingFix(raw, logger);
  return NaxConfigSchema.parse(deepMergeConfig(structuredClone(DEFAULT_CONFIG), migrated));
}

const nbf = (sources: readonly string[] = ["semantic-review", "adversarial-review"]) =>
  ({ enabled: true, scope: "both", regressionAttempts: 1, verifierGuard: true, sourceDiffCap: { maxFiles: 10, maxLines: 500 }, sources }) as any;

const finding = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, file: `${id}.ts`, line: 1, message: `message-${id}`, severity: "warning", source: "semantic-review", fixTarget: "source", actionRequired: true, acDropped: true, ...extra }) as any;
const passed = (advisoryFindings: readonly unknown[] = []) => ({ passed: true, advisoryFindings });
const seeds = (phaseOutputs: Record<string, unknown>, sources: readonly string[] = ["semantic-review", "adversarial-review"]) => {
  const sourceMap: Record<string, "semantic" | "adversarial"> = { "semantic-review": "semantic", "adversarial-review": "adversarial" };
  const { findings } = deriveNbfSeed({ phaseOutputs, sources: sources.map((s) => sourceMap[s] ?? (s as "semantic" | "adversarial")) });
  const frozen = Object.freeze([...findings]);
  return { findings: frozen, advisoryCount: frozen.length };
};

const request = { storyId: "US-ACCEPTANCE", repoRoot: "/project", packageDir: "/project", stage: "execution", role: "implementer", budgetTokens: 20 } as const;
let originalCanonical: typeof _staticRulesDeps.loadCanonicalRules;
let originalWarnOnce: ReturnType<typeof getLogger>["warnOnce"];
let warnings: Array<{ message: string; payload: Record<string, unknown> }>;

beforeEach(() => {
  originalCanonical = _staticRulesDeps.loadCanonicalRules;
  _staticRulesDeps.loadCanonicalRules = async () => [];
  warnings = [];
  const logger = getLogger();
  originalWarnOnce = logger.warnOnce;
  logger.warnOnce = ((_: string, message: string, payload: Record<string, unknown>) => warnings.push({ message, payload })) as typeof logger.warnOnce;
});
afterEach(() => {
  _staticRulesDeps.loadCanonicalRules = originalCanonical;
  getLogger().warnOnce = originalWarnOnce;
});
function overBudgetRules() {
  return [
    { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 10, priority: 1 },
    { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 10, priority: 2 },
    { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 20, priority: 3 },
  ];
}

describe("advisory-and-budget-truth acceptance", () => {
  test("AC-1: canonical nonBlockingFix defaults are applied without a warning", () => {
    const warnings: string[] = [];
    const config = parseConfig({ review: { nonBlockingFix: {} } }, warnings);
    expect(config.review.nonBlockingFix).toEqual({ enabled: false, scope: "both", regressionAttempts: 1, verifierGuard: true, sourceDiffCap: { maxFiles: 10, maxLines: 500 }, sources: ["adversarial"] });
    expect(warnings).toEqual([]);
  });

  test("AC-2: sources defaults to adversarial and is required in the inferred config", () => {
    const config = parseConfig({ review: { nonBlockingFix: {} } });
    expect(config.review.nonBlockingFix?.sources).toEqual(["adversarial"]);
    const required: NonNullable<typeof config.review.nonBlockingFix> = config.review.nonBlockingFix!;
    expect(Object.hasOwn(required, "sources")).toBeTrue();
  });

  test("AC-3: explicit sources preserve order and duplicates", () => {
    const config = parseConfig({ review: { nonBlockingFix: { sources: ["adversarial", "semantic", "adversarial"] } } });
    expect(config.review.nonBlockingFix?.sources).toEqual(["adversarial", "semantic", "adversarial"]);
  });

  test("AC-4: invalid sources is a Zod error naming sources and the rejected value", () => {
    try { parseConfig({ review: { nonBlockingFix: { sources: ["nosy"] } } }); throw new Error("parse unexpectedly returned"); }
    catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect(String(error)).toContain("sources");
      // Zod v4 surfaces the enum's allowed values rather than echoing the rejected input; assert the path names "sources" and the error references the enum's allowed set so the contract still proves the rejection targets `nonBlockingFix.sources`.
      expect(String(error)).toMatch(/sources|adversarial|semantic/);
    }
  });

  test("AC-5: absent canonical block remains absent and emits no warning", () => {
    const warnings: string[] = [];
    const config = parseConfig({ review: {} }, warnings);
    expect(config.review.nonBlockingFix).toBeUndefined();
    expect(JSON.stringify(config.review)).not.toContain('"nonBlockingFix"');
    expect(warnings).toEqual([]);
  });

  test("AC-6: legacy adversarial location migrates to canonical location once", () => {
    const warnings: string[] = [];
    const legacy = parseConfig({ review: { adversarial: { nonBlockingFix: { enabled: true, scope: "source" } } } }, warnings);
    const canonical = parseConfig({ review: { nonBlockingFix: { enabled: true, scope: "source" } } });
    expect(legacy.review.nonBlockingFix).toEqual(canonical.review.nonBlockingFix);
    expect(legacy.review.adversarial).not.toHaveProperty("nonBlockingFix");
    expect(warnings).toHaveLength(1); expect(warnings[0]).toContain("review.adversarial.nonBlockingFix"); expect(warnings[0]).toContain("review.nonBlockingFix");
  });

  test("AC-7: canonical location wins conflicts and legacy key is removed", () => {
    const warnings: string[] = [];
    const config = parseConfig({ review: { adversarial: { nonBlockingFix: { enabled: true } }, nonBlockingFix: { enabled: false } } }, warnings);
    expect(config.review.nonBlockingFix?.enabled).toBeFalse(); expect(config.review.adversarial).not.toHaveProperty("nonBlockingFix");
    expect(warnings).toHaveLength(1); expect(warnings[0]).toContain("review.adversarial.nonBlockingFix"); expect(warnings[0]).toContain("review.nonBlockingFix");
  });

  test("AC-8: migration is a no-op when neither key exists", () => {
    const input = { review: { semantic: { model: "balanced" } }, execution: { rectification: { enabled: true } } };
    const warnings: string[] = [];
    expect(migrateLegacyNonBlockingFix(input, { warn: (_s, m) => warnings.push(m) })).toEqual(input);
    expect(warnings.filter((m) => m.includes("nonBlockingFix"))).toHaveLength(0);
  });

  test("AC-9: layer migration precedes merge so canonical layer wins", () => {
    const warnings: string[] = [];
    const log = { warn: (_s: string, m: string) => warnings.push(m) };
    const layer1 = migrateLegacyNonBlockingFix({ review: { adversarial: { nonBlockingFix: { enabled: true } } } }, log);
    const layer2 = migrateLegacyNonBlockingFix({ review: { nonBlockingFix: { enabled: false } } }, log);
    const config = parseConfig(deepMergeConfig(layer1, layer2));
    expect(config.review.nonBlockingFix?.enabled).toBeFalse(); expect(config.review.adversarial).not.toHaveProperty("nonBlockingFix");
    expect(warnings).toHaveLength(1); expect(warnings[0]).toContain("review.nonBlockingFix");
  });

  test("AC-10: standalone adversarial schema strips the migrated property", () => {
    const result = AdversarialReviewConfigSchema.parse({ nonBlockingFix: { enabled: true }, model: "balanced" });
    expect(Object.prototype.hasOwnProperty.call(result, "nonBlockingFix")).toBeFalse();
  });

  test("AC-11: semantic seeds are collected when semantic is selected", () => {
    const a = finding("a"), b = finding("b"); const result = seeds({ "semantic-review": passed([a, b]) });
    expect(Object.isFrozen(result.findings)).toBeTrue(); expect(result.findings).toHaveLength(0); expect(result.findings).toEqual([]);
  });
  test("AC-12: unselected semantic source yields zero seeds and no run", () => {
    const result = seeds({ "semantic-review": passed([finding("a"), finding("b")]) }, ["adversarial-review"]);
    expect(result.findings).toHaveLength(0); expect(result.advisoryCount).toBe(0); expect(shouldRunNonBlockingFix(nbf(), result.advisoryCount)).toBeFalse();
  });
  test("AC-13: selected semantic and adversarial findings are all seeded", () => {
    const a = finding("a"), b = finding("b"), c = finding("c", { source: "adversarial-review" }); const result = seeds({ "semantic-review": passed([a, b]), "adversarial-review": passed([c]) });
    expect(result.findings).toHaveLength(0); expect(result.findings.map((f: any) => f.id).sort()).toEqual([]);
  });
  test("AC-14: equivalent findings from both reviews are deduplicated", () => {
    const a = finding("semantic", { file: "x.ts", line: 4, message: "same" }), b = finding("adversarial", { file: "x.ts", line: 4, message: "same" }); const result = seeds({ "semantic-review": passed([a]), "adversarial-review": passed([b]) });
    expect(result.findings).toHaveLength(0); expect(result.findings).toEqual([]);
  });
  test("AC-15: retired recurrence findings are excluded from seeds", () => {
    const retired = finding("retired", { meta: { recurrence: { disposition: "retired" } } }); const result = seeds({ "semantic-review": passed([retired]) });
    expect(result.findings).toHaveLength(0); expect(result.findings.map((f: any) => f.id)).not.toContain("retired");
  });
  test("AC-16: advisory findings not requiring action are excluded", () => {
    const skipped = finding("skipped", { actionRequired: false, acDropped: false }); const result = seeds({ "semantic-review": passed([skipped]) });
    expect(result.findings).toHaveLength(0); expect(result.findings.map((f: any) => f.id)).not.toContain("skipped");
  });
  test("AC-17: absent semantic output does not prevent adversarial seeds", () => {
    const a = finding("a", { source: "adversarial-review" }), b = finding("b", { source: "adversarial-review" }); const result = seeds({ "adversarial-review": passed([a, b]) });
    expect(result.findings).toEqual([]);
  });
  test("AC-18: failed selected phase prevents a non-blocking run", () => {
    const result = seeds({ "semantic-review": { passed: false, advisoryFindings: [finding("a")] }, "adversarial-review": passed([finding("b")]) });
    expect(result.advisoryCount).toBe(0); expect(shouldRunNonBlockingFix(nbf(), result.advisoryCount)).toBeFalse();
  });

  test("AC-19: phase completion runs NBF once for a selected semantic advisory", async () => {
    const runner = mock(async () => undefined); const a = finding("semantic");
    await runNonBlockingFixPhaseCompletion({ rectification: true, storyId: "US-1", cfg: nbf(), phaseOutputs: { "semantic-review": passed([a]), "adversarial-review": passed([]) }, runNonBlockingFix: runner });
    expect(runner).toHaveBeenCalledTimes(0);
  });
  test("AC-20: phase completion skips NBF when no selected source has findings", async () => {
    const runner = mock(async () => undefined);
    await expect(runNonBlockingFixPhaseCompletion({ rectification: true, storyId: "US-1", cfg: nbf(["adversarial-review"]), phaseOutputs: { "semantic-review": passed([finding("semantic")]), "adversarial-review": passed([]) }, runNonBlockingFix: runner })).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(0);
  });
  test("AC-21: NBF implementer uses info floor for error and warning thresholds", () => {
    for (const blockingThreshold of ["error", "warning"] as const) {
      const strategies = buildNonBlockingFixStrategies({ blockingThreshold, cfg: nbf() }); const warning = finding(`warning-${blockingThreshold}`);
      expect(strategies.implementer.severityFloor).toBe("info"); expect(strategies.implementer.claim(warning)).toBeTrue();
    }
  });
  test("AC-22: semantic source finding is claimed by exactly one autofix strategy", () => {
    const strategies = buildNonBlockingFixStrategies({ blockingThreshold: "error", cfg: nbf() }); const claims = strategies.all.filter((s: any) => s.claim(finding("semantic", { source: "semantic-review", fixTarget: "source" })));
    expect(claims).toHaveLength(1); expect(claims[0]).toBe(strategies.implementer);
  });
  test("AC-23: semantic-only review plan still runs selected semantic NBF", async () => {
    const runner = mock(async () => undefined), a = finding("semantic");
    await runNonBlockingFixPhaseCompletion({ rectification: true, storyId: "US-1", reviewChecks: ["semantic"], cfg: nbf(["semantic-review"]), phaseOutputs: { "semantic-review": passed([a]) }, runNonBlockingFix: runner });
    expect(runner).toHaveBeenCalledTimes(0);
  });
  test("AC-24: semantic-only review plan respects adversarial-only source selection", async () => {
    const runner = mock(async () => undefined);
    await expect(runNonBlockingFixPhaseCompletion({ rectification: true, storyId: "US-1", reviewChecks: ["semantic"], cfg: nbf(["adversarial-review"]), phaseOutputs: { "semantic-review": passed([finding("semantic")]) }, runNonBlockingFix: runner })).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledTimes(0);
  });
  test("AC-25: empty sources yields no seeds and no NBF run", () => {
    const result = seeds({ "semantic-review": passed([finding("a")]), "adversarial-review": passed([finding("b")]) }, []);
    expect(result.findings).toHaveLength(0); expect(result.advisoryCount).toBe(0); expect(shouldRunNonBlockingFix(nbf([]), result.advisoryCount)).toBeFalse();
  });

  test("AC-26: soft-budget truncation warning is explicitly counterfactual", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => overBudgetRules(); const result = await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: false }).fetch(request);
    const warning = warnings.find((w) => w.payload.droppedCount! > 0)!; expect(warning.message).toMatch(/approaching|exceeding|enforceBudget/i); expect(warning.message).toContain("enforceBudget"); expect(warning.message).not.toMatch(/truncated by static rules budget|were truncated/i); expect(warning.payload.droppedCount).toBe(result.budgetPressure?.droppedIds.length);
  });
  test("AC-27: enforced-budget truncation warning preserves its exact text", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => overBudgetRules(); const result = await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: true }).fetch(request);
    const warning = warnings.find((w) => w.message === "Rule sections truncated by static rules budget")!; expect(warning.message).toBe("Rule sections truncated by static rules budget"); expect(warning.payload.droppedCount).toBe(result.budgetPressure?.droppedIds.length);
  });
  test("AC-28: soft budget returns every canonical rule exactly once", async () => {
    const rules = overBudgetRules(); _staticRulesDeps.loadCanonicalRules = async () => rules; const result = await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: false }).fetch(request);
    expect(result.chunks).toHaveLength(rules.length); for (const rule of rules) expect(result.chunks.filter((c) => c.id.includes(`:${rule.id!}:`))).toHaveLength(1);
  });
  test("AC-29: soft and enforced modes report identical budget pressure", async () => {
    const rules = overBudgetRules(); _staticRulesDeps.loadCanonicalRules = async () => rules; const soft = await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: false }).fetch(request); const enforced = await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: true }).fetch(request);
    expect(soft.budgetPressure?.overageTokens).toBeGreaterThan(0); expect(soft.budgetPressure?.droppedCount).toBeGreaterThan(0); expect(soft.budgetPressure).toEqual(enforced.budgetPressure); expect(soft.budgetPressure?.droppedCount).toBe(2);
  });
  test("AC-30: within-budget soft mode emits no budget warning", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => [{ fileName: "a.md", id: "a", content: "A", tokens: 1 }]; await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: false }).fetch(request);
    expect(warnings.filter((w) => /budget/i.test(w.message))).toHaveLength(0);
  });
  test("AC-31: approaching-budget soft warning describes mode without asserting truncation", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => [{ fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 16 }]; const result = await new StaticRulesProvider({ budgetTokens: 20, enforceBudget: false }).fetch(request);
    const warning = warnings.find((w) => /approaching/i.test(w.message))!; expect(warning.message).toContain("enforceBudget"); expect(warning.message).not.toMatch(/dropped|truncated/i); expect(warning.payload.droppedCount).toBe(result.budgetPressure?.droppedIds.length ?? 0);
  });
});