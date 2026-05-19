/**
 * Full-Suite Gate Operation
 *
 * Runs full test suite before verifier. Detects regressions and optionally
 * triggers rectification loop.
 * Part of US-005: Promotes full-suite gate to first-class orchestrator phase.
 */

import { rectificationGateConfigSelector } from "../config/selectors";
import type { UserStory } from "../prd";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

/**
 * Full-Suite Gate execution status.
 * Covers all outcome paths from execution, parsing, rectification.
 */
export type FullSuiteGateStatus =
  | "passed"
  | "rectification-exhausted"
  | "disabled"
  | "execution-failed"
  | "inconclusive";

const VALID_STATUSES: ReadonlySet<FullSuiteGateStatus> = new Set([
  "passed",
  "rectification-exhausted",
  "disabled",
  "execution-failed",
  "inconclusive",
]);

/**
 * Input for the full-suite gate.
 * Contains story, workdir, and optional config overrides for test execution.
 */
export interface FullSuiteGateInput {
  readonly story: UserStory;
  readonly workdir: string;
  readonly featureName?: string;
  readonly projectDir?: string;
}

/**
 * Output from the full-suite gate.
 * Includes status classification and optional rectification attempts.
 */
export interface FullSuiteGateOutput {
  readonly success: boolean; // true when passed; false on any failure or disabled
  readonly passed: boolean; // true only when tests actually passed
  readonly status: FullSuiteGateStatus;
  readonly cost: number;
  readonly attempts?: number; // populated when rectification runs or disabled (0)
}

const fullSuiteGateConfigSelector = rectificationGateConfigSelector;

/**
 * Full-Suite Gate Operation — runs test suite before verifier.
 *
 * Decision tree:
 * 1. If rectification disabled in config → status: "disabled", success: false
 * 2. Run test suite with timeout
 * 3. If success && exitCode === 0 → status: "passed", success: true
 * 4. If no parseable output → status: "inconclusive", success: false (deferred to run-level gate)
 * 5. If parser inconsistency → status: "execution-failed", success: false (unreliable count)
 * 6. If failures found and rectification enabled → enter rectification loop
 * 7. If rectification loop fixes → status: "passed", success: true
 * 8. If rectification exhausts → status: "rectification-exhausted", success: false
 */
export const fullSuiteGateOp: RunOperation<
  FullSuiteGateInput,
  FullSuiteGateOutput,
  ReturnType<typeof rectificationGateConfigSelector.select>
> = {
  kind: "run",
  name: "full-suite-gate",
  stage: "run",
  config: fullSuiteGateConfigSelector,
  session: { role: "main", lifetime: "fresh" },
  build: () => ({
    role: {
      id: "full-suite-gate",
      content: "Run full test suite to detect regressions",
      overridable: false,
    },
    task: {
      id: "run-suite",
      content: "Execute full test suite with timeout",
      overridable: false,
    },
  }),
  parse: (output, _input, ctx): FullSuiteGateOutput => {
    if (!(ctx.config.execution.rectification?.enabled ?? false)) {
      return { success: false, passed: false, status: "disabled", cost: 0, attempts: 0 };
    }
    const parsed = tryParseLLMJson<Record<string, unknown>>(output);
    if (!parsed) {
      return { success: false, passed: false, status: "inconclusive", cost: 0 };
    }
    const status: FullSuiteGateStatus = VALID_STATUSES.has(parsed.status as FullSuiteGateStatus)
      ? (parsed.status as FullSuiteGateStatus)
      : "inconclusive";
    const passed = Boolean(parsed.passed);
    const cost = typeof parsed.cost === "number" ? parsed.cost : 0;
    const baseResult: FullSuiteGateOutput = {
      success: passed && status === "passed",
      passed,
      status,
      cost,
    };
    if (typeof parsed.attempts === "number") {
      return { ...baseResult, attempts: parsed.attempts };
    }
    return baseResult;
  },
};
