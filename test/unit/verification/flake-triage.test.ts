/**
 * Tests for src/verification/flake-triage.ts
 *
 * Covers AC1–AC10 for the triage layer that decides whether a `failed-test`
 * finding becomes a run-scoped `flaky-test` quarantine.
 *
 * Mock strategy: `_flakeTriageDeps.runFlakeProbe` is the injectable seam so
 * classification tests don't have to spin up subprocesses. The diff (changed
 * files + mapped test files) is passed directly via the input — the triage
 * layer composes the existing helpers upstream of itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Finding } from "../../../src/findings/types";
import type { FlakeDetectionConfig } from "../../../src/config/runtime-types";
import type { FlakeProbeVerdict } from "../../../src/verification/flake-probe";
import {
  _flakeTriageDeps,
  triageFlakyFindings,
  type FlakeTriageInput,
} from "../../../src/verification/flake-triage";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    rule: "should handle edge case",
    file: "test/unit/foo.test.ts",
    message: "expected true to equal false",
    ...overrides,
  };
}

const defaultFlakeConfig: FlakeDetectionConfig = {
  enabled: true,
  probeRuns: 2,
  maxProbesPerGate: 5,
  probeTimeoutSeconds: 30,
};

const emptyMemo = {
  has: (_key: string) => false,
  add: (_key: string) => {},
};

function makeInput(overrides: Partial<FlakeTriageInput> = {}): FlakeTriageInput {
  return {
    findings: [],
    diff: {
      changedTestFiles: [],
      mappedTestFiles: [],
    },
    flakeDetection: defaultFlakeConfig,
    baseCommand: "bun test",
    cwd: "/tmp/probe",
    framework: "bun",
    quarantineMemo: emptyMemo,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — empty findings short-circuits
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — empty findings (AC1)", () => {
  test("AC1 — returns empty findings and empty quarantine report", async () => {
    const result = await triageFlakyFindings(makeInput());
    expect(result.findings).toEqual([]);
    expect(result.quarantineReport).toEqual({ keys: [], reasons: [] });
  });

  test("AC1 — never invokes runFlakeProbe when findings are empty", async () => {
    let calls = 0;
    const orig = _flakeTriageDeps.runFlakeProbe;
    _flakeTriageDeps.runFlakeProbe = async () => {
      calls += 1;
      return { verdict: "consistent-failure", probeRuns: 1 } satisfies FlakeProbeVerdict;
    };
    try {
      await triageFlakyFindings(makeInput());
      expect(calls).toBe(0);
    } finally {
      _flakeTriageDeps.runFlakeProbe = orig;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — invokes runFlakeProbe for a pre-existing, un-mapped test
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — pre-existing test probing (AC2)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC2 — invokes probe exactly once with file, testName, and resolved config", async () => {
    const calls: Array<{ file: string; testName: string; cfg: FlakeDetectionConfig }> = [];
    _flakeTriageDeps.runFlakeProbe = async ({ failure, config }) => {
      calls.push({ file: failure.file, testName: failure.testName, cfg: config });
      return { verdict: "consistent-failure", probeRuns: 1 } satisfies FlakeProbeVerdict;
    };

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(
      makeInput({
        findings: [finding],
        // Empty diff → pre-existing and unmapped.
        diff: { changedTestFiles: [], mappedTestFiles: [] },
      }),
    );

    expect(calls.length).toBe(1);
    expect(calls[0]?.file).toBe("test/unit/foo.test.ts");
    expect(calls[0]?.testName).toBe("should work");
    expect(calls[0]?.cfg).toEqual(defaultFlakeConfig);
    expect(result.findings[0]?.category).toBe("failed-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — test file present in story's diff → no probe, stays failed-test
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — test file in diff (AC3)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC3 — skips probe when test file is in changedTestFiles", async () => {
    let probeCalls = 0;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalls += 1;
      return { verdict: "consistent-failure", probeRuns: 1 } satisfies FlakeProbeVerdict;
    };

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(
      makeInput({
        findings: [finding],
        diff: { changedTestFiles: ["test/unit/foo.test.ts"], mappedTestFiles: [] },
      }),
    );

    expect(probeCalls).toBe(0);
    expect(result.findings[0]?.category).toBe("failed-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — test file mapped from a changed source → no probe, stays failed-test
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — test file mapped from changed source (AC4)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC4 — skips probe when test file is in mappedTestFiles", async () => {
    let probeCalls = 0;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalls += 1;
      return { verdict: "consistent-failure", probeRuns: 1 } satisfies FlakeProbeVerdict;
    };

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(
      makeInput({
        findings: [finding],
        diff: {
          changedTestFiles: [],
          mappedTestFiles: ["/tmp/probe/test/unit/foo.test.ts"],
        },
      }),
    );

    expect(probeCalls).toBe(0);
    expect(result.findings[0]?.category).toBe("failed-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — verdict flaky → relabel to flaky-test with populated meta
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — verdict flaky (AC5)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC5 — relabels to flaky-test with meta.probeRuns and meta.probePasses", async () => {
    _flakeTriageDeps.runFlakeProbe = async () =>
      ({ verdict: "flaky", probeRuns: 3, probePasses: 2 } satisfies FlakeProbeVerdict);

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(makeInput({ findings: [finding] }));

    expect(result.findings[0]?.category).toBe("flaky-test");
    expect(result.findings[0]?.meta?.probeRuns).toBe(3);
    expect(result.findings[0]?.meta?.probePasses).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — verdict consistent-failure → keeps failed-test
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — verdict consistent-failure (AC6)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC6 — keeps category failed-test on consistent-failure verdict", async () => {
    _flakeTriageDeps.runFlakeProbe = async () =>
      ({ verdict: "consistent-failure", probeRuns: 2 } satisfies FlakeProbeVerdict);

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(makeInput({ findings: [finding] }));

    expect(result.findings[0]?.category).toBe("failed-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — already in run-scoped quarantine memo → relabel without re-probing
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — run-scoped quarantine memo (AC7)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC7 — relabels to flaky-test and does NOT invoke probe again", async () => {
    let probeCalls = 0;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalls += 1;
      return { verdict: "consistent-failure", probeRuns: 1 } satisfies FlakeProbeVerdict;
    };

    const memo = new Map<string, true>();
    memo.set("test/unit/foo.test.ts::should work", true);
    const quarantineMemo = {
      has: (key: string) => memo.has(key),
      add: (key: string) => {
        memo.set(key, true);
      },
    };

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(makeInput({ findings: [finding], quarantineMemo }));

    expect(probeCalls).toBe(0);
    expect(result.findings[0]?.category).toBe("flaky-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — distinct probe candidates exceed maxProbesPerGate → skip everything
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — maxProbesPerGate cap (AC8)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC8 — skips all probes and records the skip reason when over budget", async () => {
    let probeCalls = 0;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalls += 1;
      return { verdict: "consistent-failure", probeRuns: 1 } satisfies FlakeProbeVerdict;
    };

    // 6 distinct probe candidates, maxProbesPerGate=2 → over budget.
    const findings: Finding[] = [];
    for (let i = 0; i < 6; i++) {
      findings.push(makeFinding({ file: `test/unit/foo${i}.test.ts`, rule: `should work ${i}` }));
    }

    const result = await triageFlakyFindings(
      makeInput({
        findings,
        flakeDetection: { ...defaultFlakeConfig, maxProbesPerGate: 2 },
      }),
    );

    expect(probeCalls).toBe(0);
    for (const f of result.findings) {
      expect(f.category).toBe("failed-test");
    }
    expect(result.quarantineReport.reasons.some((r) => r.includes("maxProbesPerGate"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — enabled=false → findings unchanged, no probe invocation
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — disabled (AC9)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC9 — never invokes probe and returns findings unchanged when disabled", async () => {
    let probeCalls = 0;
    _flakeTriageDeps.runFlakeProbe = async () => {
      probeCalls += 1;
      return { verdict: "flaky", probeRuns: 2, probePasses: 1 } satisfies FlakeProbeVerdict;
    };

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(
      makeInput({ findings: [finding], flakeDetection: { ...defaultFlakeConfig, enabled: false } }),
    );

    expect(probeCalls).toBe(0);
    expect(result.findings[0]?.category).toBe("failed-test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — probe throws → does not propagate, finding keeps failed-test
// ─────────────────────────────────────────────────────────────────────────────

describe("triageFlakyFindings — probe dependency throws (AC10)", () => {
  afterEach(() => {
    _flakeTriageDeps.runFlakeProbe = async () => ({ verdict: "consistent-failure", probeRuns: 1 });
  });

  test("AC10 — swallows probe exception and keeps failed-test category", async () => {
    _flakeTriageDeps.runFlakeProbe = async () => {
      throw new Error("spawn EACCES");
    };

    const finding = makeFinding({ file: "test/unit/foo.test.ts", rule: "should work" });
    const result = await triageFlakyFindings(makeInput({ findings: [finding] }));

    expect(result.findings[0]?.category).toBe("failed-test");
  });
});