/**
 * Shared verdict invariants across the reviewer ops (semantic + adversarial).
 *
 * Follow-up to the reviewer note on #1379. The same defect was fixed twice: nax#1347
 * for `semanticReviewOp.verify`, nax#1378 for `adversarialReviewOp.verify`. The second
 * was possible only because nothing pinned the two verdict formulas together — #1347's
 * commit message asserted adversarial "already uses an equivalent severity-driven
 * formula" and no test contradicted it, so the divergence stayed live and later
 * deadlocked a story (otel-telemetry-expansion US-003).
 *
 * These tests drive BOTH ops' `verify()` through one scenario table. A future change to
 * either op alone goes red here, whichever half drifts.
 *
 * The invariant under test:
 *
 *   When at least one finding survives grounding, the verdict is a function of
 *   blockingThreshold — never of the model's raw `passed` flag. Concretely,
 *   `passed: false` must hand the rectification cycle at least one routable finding
 *   in `normalizedFindings`.
 *
 * Why routability is the thing that matters: `normalizedFindings` carries blocking
 * findings only. A `passed: false` with none of them is unactionable — the cycle exits
 * "resolved" without dispatching a fix strategy, `deriveTddFailureCategory` derives
 * nothing, and the story pauses on findings no agent was ever asked to fix. Retrying
 * reproduces it exactly.
 *
 * The one sanctioned exception is pinned below as INV-3: when *every* finding is
 * dropped as ungrounded the ops deliberately fall back to the model's flag (fail
 * closed), so an ungrounded-but-real blocker cannot slip through. That case is
 * unactionable by construction, and both ops must agree on it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adversarialReviewOp, semanticReviewOp } from "@/operations";
import type { AdversarialReviewInput, SemanticReviewInput } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime, withTempDir } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

/** AC text carries the "auth" locus keyword that adversarial acQuote grounding requires. */
const ACCEPTANCE_CRITERIA = [
  "AC1: auth login security must not allow SQL injection attacks",
  "AC2: handler must not throw unhandled exceptions",
];

const STORY = {
  id: "STORY-INV01",
  title: "Reviewer verdict invariants",
  description: "Shared verdict invariants across reviewer ops",
  acceptanceCriteria: ACCEPTANCE_CRITERIA,
};

const SOURCE_FILE = join("src", "auth.ts");
const SOURCE_CONTENT = "function login(u, p) { return db.rawQuery(u + p); }\n";

/** The verdict surface every reviewer op shares, normalized across their output types. */
interface Verdict {
  passed: boolean;
  /** Findings handed to the rectification cycle — `normalizedFindings.length`. */
  routable: number;
  /** Findings that survived grounding — `findings.length`. */
  surviving: number;
}

/**
 * One reviewer op under test. Each entry supplies the same three finding shapes in
 * whatever form its own grounding filters accept:
 *
 * - `advisory`      — sub-threshold, survives grounding
 * - `blocking`      — at/above threshold, survives grounding
 * - `ungrounded`    — at/above threshold, dropped by grounding
 *
 * The grounding contracts genuinely differ (semantic validates `acIndex`; adversarial
 * validates a verbatim `acQuote` against an AC locus), so the fixtures cannot be shared
 * — only the assertions can, which is the point.
 */
interface ReviewerUnderTest {
  name: string;
  advisory: () => unknown;
  blocking: () => unknown;
  ungrounded: () => unknown;
  /** Runs the op's verify() with `modelPassed` as the model's raw flag. */
  verify: (findings: unknown[], modelPassed: boolean, workdir: string) => Promise<Verdict>;
}

function makeVerifyCtx<T>(configSelector: T) {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(configSelector as never),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

const semanticReviewer: ReviewerUnderTest = {
  name: "semantic",
  advisory: () => ({
    severity: "warning",
    file: SOURCE_FILE,
    line: 1,
    issue: "Logging missing",
    suggestion: "Add logging",
    // No acIndex needed: AC-grounding skips sub-threshold findings.
  }),
  blocking: () => ({
    severity: "error",
    file: SOURCE_FILE,
    line: 1,
    issue: "SQL injection",
    suggestion: "Use parameterized queries",
    acIndex: 1,
    verifiedBy: { file: SOURCE_FILE, line: 1, observed: "db.rawQuery" },
  }),
  ungrounded: () => ({
    severity: "error",
    file: SOURCE_FILE,
    line: 1,
    issue: "Ungrounded blocker",
    suggestion: "Fix it",
    // No acIndex -> dropped as missing_ac_index.
    verifiedBy: { file: SOURCE_FILE, line: 1, observed: "db.rawQuery" },
  }),
  verify: async (findings, modelPassed, workdir) => {
    const input: SemanticReviewInput = {
      workdir,
      story: STORY,
      semanticConfig: {
        model: "balanced",
        diffMode: "ref",
        resetRefOnRerun: false,
        rules: [],
        timeoutMs: 600_000,
        substantiation: { requote: true, maxRequotes: 5 },
      },
      mode: "embedded",
      blockingThreshold: "error",
    };
    const parsed = {
      passed: modelPassed,
      findings: findings as never[],
      normalizedFindings: [],
      acDropped: [],
    };
    const result = await semanticReviewOp.verify!(parsed, input, makeVerifyCtx(semanticReviewOp.config) as never);
    expect(result).not.toBeNull();
    return {
      passed: result!.passed,
      routable: result!.normalizedFindings.length,
      surviving: result!.findings.length,
    };
  },
};

const adversarialReviewer: ReviewerUnderTest = {
  name: "adversarial",
  advisory: () => ({
    severity: "warning",
    category: "quality",
    file: SOURCE_FILE,
    line: 1,
    issue: "Logging missing",
    suggestion: "Add logging",
    // No acQuote needed: filterByAcQuote inspects blocking findings only.
  }),
  blocking: () => ({
    severity: "error",
    category: "security",
    file: SOURCE_FILE,
    line: 1,
    issue: "SQL injection",
    suggestion: "Use parameterized queries",
    acIndex: 1,
    acQuote: "auth login security must not allow SQL injection",
    verifiedBy: { file: SOURCE_FILE, line: 1, observed: "db.rawQuery" },
  }),
  ungrounded: () => ({
    severity: "error",
    category: "security",
    file: SOURCE_FILE,
    line: 1,
    issue: "Ungrounded blocker",
    suggestion: "Fix it",
    acIndex: 1,
    // No acQuote -> substantiation passes, filterByAcQuote drops it.
    verifiedBy: { file: SOURCE_FILE, line: 1, observed: "db.rawQuery" },
  }),
  verify: async (findings, modelPassed, workdir) => {
    const input: AdversarialReviewInput = {
      workdir,
      story: STORY,
      adversarialConfig: {
        model: "balanced",
        diffMode: "ref",
        rules: [],
        timeoutMs: 600_000,
        parallel: false,
        maxConcurrentSessions: 2,
        substantiation: { requote: true, maxRequotes: 5 },
      },
      mode: "ref",
      blockingThreshold: "error",
    };
    const parsed = {
      passed: modelPassed,
      findings: findings as never[],
      normalizedFindings: [],
      acDropped: [],
    };
    const result = await adversarialReviewOp.verify!(parsed, input, makeVerifyCtx(adversarialReviewOp.config) as never);
    expect(result).not.toBeNull();
    return {
      passed: result!.passed,
      routable: result!.normalizedFindings.length,
      surviving: result!.findings.length,
    };
  },
};

const REVIEWERS: ReviewerUnderTest[] = [semanticReviewer, adversarialReviewer];

/** Seeds the file both reviewers' evidence substantiation reads. */
async function withSourceFile(fn: (workdir: string) => Promise<void>): Promise<void> {
  return withTempDir(async (workdir) => {
    mkdirSync(join(workdir, "src"), { recursive: true });
    writeFileSync(join(workdir, SOURCE_FILE), SOURCE_CONTENT);
    await fn(workdir);
  });
}

describe("reviewer verdict invariants — shared across semantic and adversarial ops", () => {
  describe.each(REVIEWERS.map((r) => [r.name, r] as const))("%s", (_name, reviewer) => {
    test("INV-1: surviving sub-threshold findings do not fail the verdict, whatever the model claimed", async () => {
      // nax#1347 (semantic) / nax#1378 (adversarial). Both directions of the model
      // flag are exercised: the verdict must not depend on it once a finding survives.
      await withSourceFile(async (workdir) => {
        for (const modelPassed of [true, false]) {
          const verdict = await reviewer.verify([reviewer.advisory()], modelPassed, workdir);

          expect(verdict.surviving).toBeGreaterThan(0); // fixture really did survive grounding
          expect(verdict.passed).toBe(true); // nothing at/above threshold -> pass
          expect(verdict.routable).toBe(0); // advisory, so not routed for rectification
        }
      });
    });

    test("INV-2: a failing verdict always carries at least one routable finding", async () => {
      // The core invariant. A verdict that fails a story must hand the rectification
      // cycle something to act on, or the story deadlocks instead of being fixed.
      await withSourceFile(async (workdir) => {
        for (const modelPassed of [true, false]) {
          const verdict = await reviewer.verify([reviewer.blocking()], modelPassed, workdir);

          expect(verdict.passed).toBe(false);
          expect(verdict.routable).toBeGreaterThan(0);
        }
      });
    });

    test("INV-2: a blocking finding fails the verdict even alongside surviving advisory noise", async () => {
      // Guards the composition: an advisory survivor must not mask a real blocker.
      await withSourceFile(async (workdir) => {
        const verdict = await reviewer.verify([reviewer.advisory(), reviewer.blocking()], false, workdir);

        expect(verdict.passed).toBe(false);
        expect(verdict.routable).toBeGreaterThan(0);
      });
    });

    test("INV-3: fail-closed is the only sanctioned unactionable failure — all findings dropped", async () => {
      // The deliberate exception. Every finding dropped as ungrounded (surviving === 0)
      // means the op has no threshold signal to reason from, so it defers to the model's
      // claim. #1379 weakened then restored this on the adversarial side; pinning it for
      // both ops keeps a future "make the invariant total" change from silently reopening
      // the hole where an ungrounded-but-real blocker gets waved through.
      await withSourceFile(async (workdir) => {
        const failing = await reviewer.verify([reviewer.ungrounded()], false, workdir);
        expect(failing.surviving).toBe(0); // fixture really was dropped
        expect(failing.passed).toBe(false); // fail closed on the model's claim
        expect(failing.routable).toBe(0); // unactionable, by construction

        // Same drop, model claims success -> nothing to fail on.
        const passing = await reviewer.verify([reviewer.ungrounded()], true, workdir);
        expect(passing.surviving).toBe(0);
        expect(passing.passed).toBe(true);
      });
    });
  });

  test("both ops agree on every scenario — no reviewer-specific verdict semantics", async () => {
    // Catches one op being changed without the other: the two verdict formulas must
    // produce identical (passed, routable > 0) pairs for equivalent inputs. This is the
    // assertion #1347 lacked, which let the adversarial half stay on the old formula.
    await withSourceFile(async (workdir) => {
      const scenarios: Array<{ label: string; pick: (r: ReviewerUnderTest) => unknown[]; modelPassed: boolean }> = [
        { label: "advisory-only, model failed", pick: (r) => [r.advisory()], modelPassed: false },
        { label: "advisory-only, model passed", pick: (r) => [r.advisory()], modelPassed: true },
        { label: "blocking, model failed", pick: (r) => [r.blocking()], modelPassed: false },
        { label: "blocking, model passed", pick: (r) => [r.blocking()], modelPassed: true },
        { label: "advisory + blocking", pick: (r) => [r.advisory(), r.blocking()], modelPassed: false },
        { label: "all dropped, model failed", pick: (r) => [r.ungrounded()], modelPassed: false },
        { label: "all dropped, model passed", pick: (r) => [r.ungrounded()], modelPassed: true },
      ];

      for (const scenario of scenarios) {
        const verdicts = await Promise.all(
          REVIEWERS.map(async (reviewer) => {
            const verdict = await reviewer.verify(scenario.pick(reviewer), scenario.modelPassed, workdir);
            return { reviewer: reviewer.name, passed: verdict.passed, hasRoutable: verdict.routable > 0 };
          }),
        );

        const [semantic, adversarial] = verdicts;
        expect({ scenario: scenario.label, ...semantic, reviewer: undefined }).toEqual({
          scenario: scenario.label,
          passed: adversarial.passed,
          hasRoutable: adversarial.hasRoutable,
          reviewer: undefined,
        });
      }
    });
  });
});
