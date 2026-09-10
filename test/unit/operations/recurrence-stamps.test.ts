/**
 * US-003 — Persist recurrence stamps through review operations.
 *
 * Covers AC1-AC14 by exercising:
 *   - `toAdversarialReviewFindings` (mapper forwards meta.recurrence / meta.verifiedBy)
 *   - `llmFindingToFinding` (mapper forwards meta.recurrence)
 *   - `adversarialReviewOp.verify()` (findings = classified, advisoryFindings
 *     includes retired, normalizedFindings excludes retired, recurrence_retired
 *     log per retired, recurrence_demoted log per demoted, passed remains true
 *     when blocking is empty post-demotion)
 *   - `semanticReviewOp.verify()` (findings stamped when enabled, advisoryFindings
 *     carries no meta.recurrence when disabled)
 *   - audit-record roundtrip (result.findings exposes the stamp on a persisted
 *     ReviewAuditEntry)
 *
 * The implementations being tested are in `src/operations/{adversarial,semantic}-review.ts`,
 * `src/review/{adversarial,semantic}-helpers.ts`, and the audit layer in
 * `src/execution/story-orchestrator/review-decision.ts` + `src/review/review-audit.ts`.
 * Tests use real mapper/op code paths; the only stubbed boundary is the logger
 * (via `withInfoSpy`) so log events can be asserted directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeAdversarialReviewConfig,
  makeTestRuntime,
  opSelector,
  withInfoSpy,
  withTempDir,
} from "@test/helpers";
import type { Iteration } from "@/findings";
import type { AdversarialReviewInput, AdversarialReviewOutput } from "@/operations/adversarial-review";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { SemanticReviewInput, SemanticReviewOutput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { AdversarialLLMFinding } from "@/review/adversarial-helpers";
import { toAdversarialReviewFindings } from "@/review/adversarial-helpers";
import type { ReviewAuditEntry } from "@/review/review-audit";
import { toPersistedEntry } from "@/review/review-audit";
import type { LLMFinding } from "@/review/semantic-helpers";
import { llmFindingToFinding } from "@/review/semantic-helpers";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const STORY = {
  id: "STORY-US003",
  title: "Persist recurrence stamps through review operations",
  description: "Stamps must reach the audit record and the prompt builder.",
  acceptanceCriteria: ["AC1: auth module must not allow SQL injection attacks"],
};

function makeVerifyCtx(op: typeof adversarialReviewOp | typeof semanticReviewOp) {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return {
    packageView: view,
    config: view.select(opSelector(op.config)),
    readFile: async (_path: string) => null as string | null,
    fileExists: async (_path: string) => false,
  };
}

function makeAdvOutput(overrides: Partial<AdversarialReviewOutput> = {}): AdversarialReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

function makeSemOutput(overrides: Partial<SemanticReviewOutput> = {}): SemanticReviewOutput {
  return { passed: true, findings: [], normalizedFindings: [], acDropped: [], ...overrides };
}

function priorAdvRound(
  n: number,
  message: string,
  severity: "error" | "warning" | "info" = "warning",
  file = "src/auth.ts",
  category = "security",
): Iteration {
  return {
    iterationNum: n,
    findingsBefore: [],
    fixesApplied: [],
    findingsAfter: [{ source: "adversarial-review", severity, category, file, message }],
    outcome: "unchanged",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: "2026-09-10T00:00:01.000Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapper-level: toAdversarialReviewFindings forwards meta.recurrence (AC1, AC2, AC3)
// ─────────────────────────────────────────────────────────────────────────────

describe("toAdversarialReviewFindings — forwards meta.recurrence (AC1/AC2/AC3)", () => {
  // AC1 — meta.recurrence disposes through to Finding.meta.recurrence.
  test("AC1: forwards meta.recurrence with disposition, rounds, wasBlocking intact", () => {
    const llm: AdversarialLLMFinding = {
      severity: "warning",
      category: "input",
      file: "a.ts",
      line: 1,
      issue: "sub-threshold recurring",
      suggestion: "fix",
      meta: { recurrence: { disposition: "retired", rounds: 3, wasBlocking: false } },
    };
    const [mapped] = toAdversarialReviewFindings([llm]);
    assertDefined(mapped, "mapped finding");
    expect(mapped.meta?.recurrence).toEqual({
      disposition: "retired",
      rounds: 3,
      wasBlocking: false,
    });
  });

  // AC2 — no meta → no recurrence key in Finding.meta.
  test("AC2: finding with no meta yields Finding.meta without recurrence key", () => {
    const llm: AdversarialLLMFinding = {
      severity: "warning",
      category: "input",
      file: "a.ts",
      line: 1,
      issue: "no meta at all",
      suggestion: "fix",
    };
    const [mapped] = toAdversarialReviewFindings([llm]);
    assertDefined(mapped, "mapped finding");
    if (mapped.meta !== undefined) {
      expect("recurrence" in mapped.meta).toBe(false);
    }
  });

  // AC3 — meta.recurrence and meta.verifiedBy coexist on the Finding.
  test("AC3: meta.recurrence and meta.verifiedBy coexist on the mapped Finding", () => {
    const llm: AdversarialLLMFinding = {
      severity: "error",
      category: "security",
      file: "a.ts",
      line: 1,
      issue: "SQL injection",
      suggestion: "use parameterised query",
      acIndex: 1,
      acQuote: "must not allow SQL injection",
      verifiedBy: { file: "a.ts", line: 1, observed: "rawQuery" },
      meta: { recurrence: { disposition: "blocking", rounds: 1 } },
    };
    const [mapped] = toAdversarialReviewFindings([llm]);
    assertDefined(mapped, "mapped finding");
    expect(mapped.meta?.recurrence).toEqual({ disposition: "blocking", rounds: 1 });
    expect(mapped.meta?.verifiedBy).toEqual({ file: "a.ts", line: 1, observed: "rawQuery" });
    // AC grounding metadata must also survive the mapper — they ride together.
    expect(mapped.meta?.acQuote).toBe("must not allow SQL injection");
    expect(mapped.meta?.acIndex).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapper-level: llmFindingToFinding forwards meta.recurrence (AC4)
// ─────────────────────────────────────────────────────────────────────────────

describe("llmFindingToFinding — forwards meta.recurrence (AC4)", () => {
  test("AC4: semantic LLM finding with meta.recurrence produces Finding with same recurrence", () => {
    const llm: LLMFinding = {
      severity: "warning",
      category: "convention",
      file: "b.ts",
      line: 5,
      issue: "stale doc comment",
      suggestion: "remove",
      meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
    };
    const mapped = llmFindingToFinding(llm);
    expect(mapped.meta?.recurrence).toEqual({ disposition: "retired", rounds: 4, wasBlocking: false });
  });

  test("AC4 boundary: semantic LLM finding without meta yields Finding.meta without recurrence key", () => {
    const llm: LLMFinding = {
      severity: "warning",
      category: "convention",
      file: "b.ts",
      line: 5,
      issue: "no meta here",
      suggestion: "remove",
    };
    const mapped = llmFindingToFinding(llm);
    if (mapped.meta !== undefined) {
      expect("recurrence" in mapped.meta).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// adversarialReviewOp.verify — classified persistence + retired routing (AC5, AC6, AC7, AC8, AC9, AC10, AC14)
// ─────────────────────────────────────────────────────────────────────────────

describe("adversarialReviewOp.verify() — recurrence stamps reach findings + advisoryFindings (AC5/AC6/AC7/AC8)", () => {
  // AC5 — when a finding is accepted by classifyRecurrence, the returned
  // `findings` field carries one stamped entry per accepted finding.
  test("AC5: classifyRecurrence accepted finding surfaces in findings stamped", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "function login() { return true; }\n");

      const input: AdversarialReviewInput = {
        workdir,
        story: STORY,
        blockingThreshold: "error",
        adversarialConfig: makeAdversarialReviewConfig({
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        }),
        mode: "embedded",
      };
      const parsed = makeAdvOutput({
        passed: true,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "SQL injection via concatenation",
            suggestion: "Use parameterised query",
            acIndex: 1,
            acQuote: "auth module must not allow SQL injection attacks",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "login" },
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));
      assertDefined(out, "verify() result");
      expect(out.findings).toHaveLength(1);
      const stamped = out.findings[0] as Record<string, unknown>;
      expect(stamped.meta).toBeDefined();
      expect((stamped.meta as Record<string, unknown>).recurrence).toEqual({
        disposition: "blocking",
        rounds: 1,
      });
    });
  });

  // AC6 — retired entries reach advisoryFindings alongside advisory, demoted, and AC-dropped.
  test("AC6: retired sub-threshold finding joins advisoryFindings alongside plain advisory", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "a.ts"), "// content\n");

      const input: AdversarialReviewInput = {
        workdir,
        story: STORY,
        blockingThreshold: "error",
        adversarialConfig: makeAdversarialReviewConfig({
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        }),
        priorAdversarialIterations: [priorAdvRound(1, "sub-threshold recurring", "warning")],
        mode: "embedded",
      };
      const parsed = makeAdvOutput({
        passed: true,
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "sub-threshold recurring",
            suggestion: "fix",
          },
          {
            severity: "warning",
            category: "convention",
            file: "src/a.ts",
            line: 2,
            issue: "plain advisory",
            suggestion: "consider",
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));
      assertDefined(out, "verify() result");
      assertDefined(out.advisoryFindings, "advisoryFindings");
      const messages = out.advisoryFindings.map((f) => f.message);
      expect(messages).toContain("sub-threshold recurring"); // retired
      expect(messages).toContain("plain advisory"); // plain advisory
    });
  });

  // AC7 — normalizedFindings contains only blocking entries; retired never routable.
  test("AC7: normalizedFindings is empty when the only accepted finding is retired", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "a.ts"), "// content\n");

      const input: AdversarialReviewInput = {
        workdir,
        story: STORY,
        blockingThreshold: "error",
        adversarialConfig: makeAdversarialReviewConfig({
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        }),
        priorAdversarialIterations: [priorAdvRound(1, "sub-threshold recurring", "warning")],
        mode: "embedded",
      };
      const parsed = makeAdvOutput({
        passed: true,
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "sub-threshold recurring",
            suggestion: "fix",
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));
      assertDefined(out, "verify() result");
      expect(out.normalizedFindings).toHaveLength(0);
    });
  });

  // AC8 — warning + sufficient matching priors retires into advisoryFindings stamped retired.
  test("AC8: warning + maxAdvisoryRounds priors retires into advisoryFindings stamped retired", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "a.ts"), "// content\n");

      const input: AdversarialReviewInput = {
        workdir,
        story: STORY,
        blockingThreshold: "error",
        adversarialConfig: makeAdversarialReviewConfig({
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        }),
        priorAdversarialIterations: [priorAdvRound(1, "warn recurring", "warning")],
        mode: "embedded",
      };
      const parsed = makeAdvOutput({
        passed: true,
        findings: [
          {
            severity: "warning",
            category: "input",
            file: "src/a.ts",
            line: 1,
            issue: "warn recurring",
            suggestion: "fix",
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));
      assertDefined(out, "verify() result");
      assertDefined(out.advisoryFindings, "advisoryFindings");
      const retired = out.advisoryFindings.find((f) => f.message === "warn recurring");
      assertDefined(retired, "retired advisory");
      const rec = retired.meta?.recurrence as
        | { disposition?: string; rounds?: number; wasBlocking?: boolean }
        | undefined;
      expect(rec?.disposition).toBe("retired");
      expect(rec?.wasBlocking).toBe(false);
      expect(typeof rec?.rounds).toBe("number");
    });
  });
});

describe("adversarialReviewOp.verify() — recurrence telemetry (AC9/AC10)", () => {
  // AC9 — one info log per retired finding with event review.adversarial.recurrence_retired.
  test("AC9: emits one review.adversarial.recurrence_retired log per retired finding", async () => {
    return withInfoSpy(async (infoSpy) => {
      return withTempDir(async (workdir) => {
        mkdirSync(join(workdir, "src"), { recursive: true });
        writeFileSync(join(workdir, "src", "a.ts"), "// content\n");

        const input: AdversarialReviewInput = {
          workdir,
          story: STORY,
          blockingThreshold: "error",
          adversarialConfig: makeAdversarialReviewConfig({
            recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
          }),
          priorAdversarialIterations: [priorAdvRound(1, "alpha", "warning"), priorAdvRound(2, "beta", "warning")],
          mode: "embedded",
        };
        const parsed = makeAdvOutput({
          passed: true,
          findings: [
            {
              severity: "warning",
              category: "input",
              file: "src/a.ts",
              line: 1,
              issue: "alpha",
              suggestion: "fix",
            },
            {
              severity: "warning",
              category: "input",
              file: "src/b.ts",
              line: 1,
              issue: "beta",
              suggestion: "fix",
            },
          ],
        });

        const { verify } = adversarialReviewOp;
        assertDefined(verify, "adversarialReviewOp.verify");
        await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));

        const retiredCalls = infoSpy.mock.calls.filter((c) => {
          const data = c[2] as { event?: string } | undefined;
          return data?.event === "review.adversarial.recurrence_retired";
        });
        expect(retiredCalls).toHaveLength(2);
        // Each retired log carries the file and category of its finding.
        const data0 = retiredCalls[0]?.[2] as { file?: string; category?: string };
        const data1 = retiredCalls[1]?.[2] as { file?: string; category?: string };
        expect([data0?.file, data1?.file].sort()).toEqual(["src/a.ts", "src/b.ts"]);
        expect(data0?.category).toBe("input");
        expect(data1?.category).toBe("input");
      });
    });
  });

  // AC10 — demoted findings still emit one log per finding (event review.adversarial.recurrence_demoted).
  test("AC10: emits one review.adversarial.recurrence_demoted log per demoted finding", async () => {
    return withInfoSpy(async (infoSpy) => {
      return withTempDir(async (workdir) => {
        mkdirSync(join(workdir, "src"), { recursive: true });
        writeFileSync(join(workdir, "src", "auth.ts"), "// content for auth\n");

        const input: AdversarialReviewInput = {
          workdir,
          story: STORY,
          blockingThreshold: "error",
          adversarialConfig: makeAdversarialReviewConfig({
            recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
          }),
          priorAdversarialIterations: [
            priorAdvRound(1, "demote me", "error", "src/auth.ts"),
            priorAdvRound(2, "demote me", "error", "src/auth.ts"),
          ],
          mode: "embedded",
        };
        const parsed = makeAdvOutput({
          passed: true,
          findings: [
            {
              severity: "error",
              category: "security",
              file: "src/auth.ts",
              line: 1,
              issue: "demote me",
              suggestion: "fix",
              acIndex: 1,
              acQuote: "auth module must not allow SQL injection attacks",
              // verifiedBy must substantiate so the finding stays blocking through demotion
              verifiedBy: { file: "src/auth.ts", line: 1, observed: "content for auth" },
            },
          ],
        });

        const { verify } = adversarialReviewOp;
        assertDefined(verify, "adversarialReviewOp.verify");
        await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));

        const demotedCalls = infoSpy.mock.calls.filter((c) => {
          const data = c[2] as { event?: string } | undefined;
          return data?.event === "review.adversarial.recurrence_demoted";
        });
        expect(demotedCalls.length).toBeGreaterThanOrEqual(1);
        const data = demotedCalls[0]?.[2] as { file?: string; category?: string };
        expect(data?.file).toBe("src/auth.ts");
        expect(data?.category).toBe("security");
      });
    });
  });
});

describe("adversarialReviewOp.verify() — verdict preservation under demotion (AC14)", () => {
  // AC14 — an error demoted to advisory, blocking empty → passed=true.
  test("AC14: demoted error + empty blocking returns passed=true (verdict unchanged)", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "// content\n");

      const input: AdversarialReviewInput = {
        workdir,
        story: STORY,
        blockingThreshold: "error",
        adversarialConfig: makeAdversarialReviewConfig({
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        }),
        priorAdversarialIterations: [
          priorAdvRound(1, "demote me", "error", "src/auth.ts"),
          priorAdvRound(2, "demote me", "error", "src/auth.ts"),
        ],
        mode: "embedded",
      };
      const parsed = makeAdvOutput({
        passed: true,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "demote me",
            suggestion: "fix",
            acIndex: 1,
            acQuote: "auth module must not allow SQL injection attacks",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "login" },
          },
        ],
      });

      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));
      assertDefined(out, "verify() result");
      expect(out.passed).toBe(true);
      expect(out.normalizedFindings).toHaveLength(0);
      assertDefined(out.advisoryFindings, "advisoryFindings");
      // The demoted error is in advisoryFindings, not normalizedFindings.
      expect(out.advisoryFindings.some((f) => f.message === "demote me")).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// semanticReviewOp.verify — stamping behaviour (AC11, AC12)
// ─────────────────────────────────────────────────────────────────────────────

describe("semanticReviewOp.verify() — recurrence stamping (AC11/AC12)", () => {
  // AC11 — when semantic recurrenceDemotion.enabled is true, accepted
  // findings surface in `findings` stamped with meta.recurrence.
  test("AC11: with recurrenceDemotion.enabled=true, accepted finding surfaces in findings stamped", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "h.ts"), "function login() { return true; }\n");

      const input: SemanticReviewInput = {
        workdir,
        story: STORY,
        semanticConfig: {
          model: "balanced" as const,
          diffMode: "embedded" as const,
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 600_000,
          substantiation: { requote: true, maxRequotes: 5 },
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        },
        mode: "embedded",
        blockingThreshold: "error",
      };
      const parsed = makeSemOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            category: "unimplemented",
            file: "src/h.ts",
            line: 1,
            issue: "AC0 unimplemented",
            suggestion: "fix",
            acIndex: 1,
          },
        ],
      });
      const { verify } = semanticReviewOp;
      assertDefined(verify, "semanticReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(semanticReviewOp));
      assertDefined(out, "verify() result");
      expect(out.findings).toHaveLength(1);
      const stamped = out.findings[0] as Record<string, unknown>;
      const meta = stamped.meta as Record<string, unknown> | undefined;
      expect(meta?.recurrence).toBeDefined();
      const recurrence = meta?.recurrence as { disposition?: string } | undefined;
      expect(recurrence?.disposition).toBeDefined();
    });
  });

  // AC12 — with the false default (no recurrenceDemotion), advisoryFindings
  // entries carry no meta.recurrence.
  test("AC12: with recurrenceDemotion enabled=false (default), advisoryFindings carry no meta.recurrence", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "h.ts"), "function login() { return true; }\n");

      const input: SemanticReviewInput = {
        workdir,
        story: STORY,
        semanticConfig: {
          model: "balanced" as const,
          diffMode: "embedded" as const,
          resetRefOnRerun: false,
          rules: [],
          timeoutMs: 600_000,
          substantiation: { requote: true, maxRequotes: 5 },
          // recurrenceDemotion omitted entirely → defaults to enabled:false
        },
        mode: "embedded",
        blockingThreshold: "error",
      };
      const parsed = makeSemOutput({
        passed: false,
        findings: [
          {
            severity: "warning",
            category: "convention",
            file: "src/h.ts",
            line: 1,
            issue: "advisory only",
            suggestion: "consider",
            acIndex: 1,
          },
        ],
      });
      const { verify } = semanticReviewOp;
      assertDefined(verify, "semanticReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(semanticReviewOp));
      assertDefined(out, "verify() result");
      assertDefined(out.advisoryFindings, "advisoryFindings");
      for (const adv of out.advisoryFindings) {
        if (adv.meta !== undefined) {
          expect("recurrence" in adv.meta).toBe(false);
        }
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit record roundtrip (AC13)
// ─────────────────────────────────────────────────────────────────────────────

describe("ReviewAuditEntry — result.findings exposes meta.recurrence (AC13)", () => {
  // AC13 — when a review-audit entry is built from adversarial verify output
  // with recurrence stamps, result.findings exposes those values so a passed
  // record distinguishes a demoted error without replaying demotion state.
  test("AC13: persisted ReviewAuditEntry.result.findings carries meta.recurrence from the LLM finding", async () => {
    return withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src", "auth.ts"), "// content\n");

      const input: AdversarialReviewInput = {
        workdir,
        story: STORY,
        blockingThreshold: "error",
        adversarialConfig: makeAdversarialReviewConfig({
          recurrenceDemotion: { enabled: true, maxBlockingRounds: 2, maxAdvisoryRounds: 2 },
        }),
        priorAdversarialIterations: [
          priorAdvRound(1, "demote me", "error", "src/auth.ts"),
          priorAdvRound(2, "demote me", "error", "src/auth.ts"),
        ],
        mode: "embedded",
      };
      const parsed = makeAdvOutput({
        passed: true,
        findings: [
          {
            severity: "error",
            category: "security",
            file: "src/auth.ts",
            line: 1,
            issue: "demote me",
            suggestion: "fix",
            acIndex: 1,
            acQuote: "auth module must not allow SQL injection attacks",
            verifiedBy: { file: "src/auth.ts", line: 1, observed: "login" },
          },
        ],
      });
      const { verify } = adversarialReviewOp;
      assertDefined(verify, "adversarialReviewOp.verify");
      const out = await verify(parsed, input, makeVerifyCtx(adversarialReviewOp));
      assertDefined(out, "verify() result");

      // Audit entry mirrors what review-decision.ts would persist.
      const entry: ReviewAuditEntry = {
        reviewer: "adversarial",
        sessionName: "sess",
        workdir,
        parsed: true,
        passed: out.passed,
        result: { passed: out.passed, findings: out.findings as unknown[] },
        advisoryFindings: out.advisoryFindings,
      };
      const persisted = toPersistedEntry(entry, Date.now());
      const parsedJson: {
        result: { findings: Array<{ meta?: { recurrence?: { disposition?: string; wasBlocking?: boolean } } }> };
      } = JSON.parse(persisted);
      expect(parsedJson.result.findings).toHaveLength(1);
      const rec = parsedJson.result.findings[0]?.meta?.recurrence;
      expect(rec?.disposition).toBe("demoted");
      expect(rec?.wasBlocking).toBe(true);
    });
  });
});
