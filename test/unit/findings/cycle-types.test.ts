/**
 * cycle-types — AC3.7
 *
 * Structural (compile-time) tests verifying the FixCycle<F>.validate signature
 * accepts the optional `strategiesRun` field on the opts object.
 */

import { describe, expect, test } from "bun:test";
import type { FixCycle, FixCycleContext, FixCycleExitReason, ValidateResult } from "@/findings/cycle-types";
import type { Finding } from "@/findings/types";

// ─────────────────────────────────────────────────────────────────────────────
// AC3.7: validate signature accepts optional strategiesRun field
// ─────────────────────────────────────────────────────────────────────────────

describe("FixCycle — AC3.7: validate signature includes optional strategiesRun", () => {
  test("AC3.7: validate accepts opts with strategiesRun set to a readonly string array", () => {
    const cycle: FixCycle<Finding> = {
      findings: [],
      iterations: [],
      strategies: [],
      config: { maxAttemptsTotal: 1, validatorRetries: 0 },
      validate: async (_ctx: FixCycleContext, opts) => {
        // strategiesRun is a valid field on opts (optional)
        const _names: readonly string[] | undefined = opts.strategiesRun;
        void _names;
        return [];
      },
    };
    expect(typeof cycle.validate).toBe("function");
  });

  test("AC3.7: validate accepts opts without strategiesRun (field is optional)", () => {
    const cycle: FixCycle<Finding> = {
      findings: [],
      iterations: [],
      strategies: [],
      config: { maxAttemptsTotal: 1, validatorRetries: 0 },
      validate: async (_ctx: FixCycleContext, opts) => {
        // opts.strategiesRun may be undefined — that is valid
        const _mode: "full" | "lite" = opts.mode;
        void _mode;
        return [];
      },
    };
    expect(typeof cycle.validate).toBe("function");
  });

  test("AC3.7: validate accepts both mode and strategiesRun together", () => {
    const cycle: FixCycle<Finding> = {
      findings: [],
      iterations: [],
      strategies: [],
      config: { maxAttemptsTotal: 1, validatorRetries: 0 },
      validate: async (_ctx: FixCycleContext, opts) => {
        const _mode: "full" | "lite" = opts.mode;
        const _names: readonly string[] | undefined = opts.strategiesRun;
        void _mode;
        void _names;
        return [];
      },
    };

    // Runtime check: the validate function must be callable with and without strategiesRun
    expect(typeof cycle.validate).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: FixCycleExitReason includes "validate-short-circuit"
// ─────────────────────────────────────────────────────────────────────────────

describe("FixCycleExitReason — AC1: validate-short-circuit member", () => {
  test("AC1: 'validate-short-circuit' is assignable to FixCycleExitReason", () => {
    const reason: FixCycleExitReason = "validate-short-circuit";
    expect(reason).toBe("validate-short-circuit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: ValidateResult interface shape
// ─────────────────────────────────────────────────────────────────────────────

describe("ValidateResult — AC2: interface members", () => {
  test("AC2: ValidateResult accepts findings and shortCircuited: true", () => {
    const lintFinding: Finding = { source: "lint", message: "no-unused-vars", severity: "error", category: "test" };
    const result: ValidateResult<Finding> = { findings: [lintFinding], shortCircuited: true };
    expect(result.findings).toHaveLength(1);
    expect(result.shortCircuited).toBe(true);
  });

  test("AC2: ValidateResult shortCircuited is optional (may be omitted)", () => {
    const result: ValidateResult<Finding> = { findings: [] };
    expect(result.findings).toHaveLength(0);
    expect(result.shortCircuited).toBeUndefined();
  });

  test("AC2: ValidateResult accepts shortCircuited: false", () => {
    const result: ValidateResult<Finding> = { findings: [], shortCircuited: false };
    expect(result.shortCircuited).toBe(false);
  });
});
