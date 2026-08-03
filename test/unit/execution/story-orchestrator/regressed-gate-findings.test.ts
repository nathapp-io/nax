/**
 * #1452 — `selectRegressedGateFindings` must agree with `describeGateRegression`.
 *
 * The rectification validate sweep feeds the fix cycle whatever this selector returns
 * when the verifier-SSOT carve-out fires. If it disagreed with the keep-decision that
 * later judges the same gate output, the cycle would either chase failures the story is
 * exempt from, or (as before #1452) miss the ones it will be failed on.
 */
import { describe, expect, test } from "bun:test";
import { describeGateRegression, selectRegressedGateFindings } from "@/execution";
import type { Finding } from "@/findings/types";

const finding = (file: string, rule: string, category = ""): Finding =>
  ({ source: "test-runner", severity: "error", category, message: `${file} failed`, file, rule }) as unknown as Finding;

const key = (f: Finding): string => `${f.file}::${f.rule}`;

describe("selectRegressedGateFindings (#1452)", () => {
  const preExisting = finding("tests/old.py", "test_a");
  const introduced = finding("tests/new.py", "test_b");

  test("keeps failures absent from the baseline", () => {
    const selected = selectRegressedGateFindings([preExisting, introduced], new Set([key(preExisting)]));
    expect(selected).toEqual([introduced]);
  });

  test("drops every failure when all are in the baseline", () => {
    const baseline = new Set([key(preExisting), key(introduced)]);
    expect(selectRegressedGateFindings([preExisting, introduced], baseline)).toEqual([]);
  });

  test("an empty baseline makes every failure a regression", () => {
    expect(selectRegressedGateFindings([preExisting, introduced], new Set())).toEqual([preExisting, introduced]);
  });

  test("keyless failures (timeout / execution-failure) are always regressions", () => {
    const keyless = { source: "test-runner", severity: "error", category: "", message: "gate timed out" } as Finding;
    expect(selectRegressedGateFindings([keyless], new Set(["::"]))).toEqual([keyless]);
  });

  test("quarantined flakes are excluded — #1383 parity", () => {
    const flake = finding("tests/flaky.py", "test_c");
    const selected = selectRegressedGateFindings([flake, introduced], new Set(), new Set([key(flake)]));
    expect(selected).toEqual([introduced]);
  });

  test("findings already relabelled flaky-test are excluded", () => {
    const relabelled = finding("tests/flaky.py", "test_c", "flaky-test");
    expect(selectRegressedGateFindings([relabelled, introduced], new Set())).toEqual([introduced]);
  });

  test("agrees with describeGateRegression on whether the gate regressed", () => {
    const baseline = new Set([key(preExisting)]);
    for (const findings of [[preExisting], [preExisting, introduced], [introduced], []]) {
      const gateOutput = { success: findings.length === 0, passed: findings.length === 0, findings };
      const viaDescribe = describeGateRegression({
        gateOutput,
        baselineKeys: baseline,
        gateName: "full-suite-gate",
        storyId: "US-1452",
      }).regressed;
      const viaSelector = selectRegressedGateFindings(findings, baseline).length > 0;
      expect(viaSelector).toBe(viaDescribe);
    }
  });
});
