import { describe, expect, test } from "bun:test";
import type { AcceptanceGateResult, FinishPhaseState, QualityGateResult } from "@/finish";
import {
  acceptanceFact,
  gateCommitRoute,
  gateFacts,
  MAX_FIX_ATTEMPTS,
  MAX_REVIEW_ROUNDS,
  partitionTestFiles,
  routeAcceptance,
  routeQualityGates,
} from "@/finish";

const zeroedState = (): FinishPhaseState => ({
  fixAttempts: 0,
  reviewAttempts: 0,
  rounds: 0,
});

describe("routeAcceptance", () => {
  const passedResult = (overrides: Partial<AcceptanceGateResult> = {}): AcceptanceGateResult => ({
    passed: true,
    ran: 1,
    missing: [],
    output: "ok",
    ...overrides,
  });

  test("a passing run with nothing missing proceeds green", () => {
    const r = routeAcceptance(passedResult(), zeroedState());
    expect(r).toEqual({ route: "proceed", fact: "green" });
  });

  test("a passing run with a missing acceptance target stops unverified", () => {
    const r = routeAcceptance(passedResult({ missing: ["pkg-a"] }), zeroedState());
    expect(r.route).toBe("stop");
    expect(r.fact).toBe("unverified");
    expect(r.reason).toBe("Acceptance test never generated for: pkg-a.");
  });

  test("a passing run that ran nothing at all stops unverified", () => {
    const r = routeAcceptance(passedResult({ ran: 0 }), zeroedState());
    expect(r.route).toBe("stop");
    expect(r.fact).toBe("unverified");
  });

  test("a failing run under the fix cap routes fix and is red", () => {
    const r = routeAcceptance(passedResult({ passed: false }), zeroedState());
    expect(r).toEqual({ route: "fix", fact: "red" });
  });

  test("a failing run past the fix cap stops red with the cap reason", () => {
    const st = { ...zeroedState(), fixAttempts: MAX_FIX_ATTEMPTS };
    const r = routeAcceptance(passedResult({ passed: false }), st);
    expect(r.route).toBe("stop");
    expect(r.fact).toBe("red");
    expect(r.reason).toBe(`Acceptance tests still failing after ${MAX_FIX_ATTEMPTS} fix attempts.`);
  });
});

describe("acceptanceFact", () => {
  const result = (over: Partial<AcceptanceGateResult> = {}): AcceptanceGateResult => ({
    passed: true,
    ran: 1,
    missing: [],
    output: "",
    ...over,
  });

  test.each([
    ["disabled status is not-configured, whatever ran", result({ ran: 0 }), "disabled", "not-configured"],
    ["passed and ran is green", result(), "ok", "green"],
    ["passed with a missing target is unverified", result({ missing: ["p"] }), "ok", "unverified"],
    ["passed with nothing run is unverified", result({ ran: 0 }), "ok", "unverified"],
    ["no-prd with nothing run is unverified, never a pass", result({ ran: 0 }), "no-prd", "unverified"],
    ["failed is red", result({ passed: false }), "ok", "red"],
  ] as const)("%s", (_name, input, status, expected) => {
    expect(acceptanceFact(input, status)).toBe(expected);
  });
});

describe("routeQualityGates", () => {
  const passedResult = (overrides: Partial<QualityGateResult> = {}): QualityGateResult => ({
    passed: true,
    ran: ["test"],
    failing: [],
    output: "ok",
    ...overrides,
  });

  test("a passing run routes green", () => {
    const r = routeQualityGates(passedResult(), zeroedState());
    expect(r.route).toBe("green");
  });

  test("nothing configured stops with the byte-identical reason", () => {
    const r = routeQualityGates(passedResult({ passed: false, ran: [] }), zeroedState());
    expect(r.route).toBe("stop");
    expect(r.reason).toBe("No quality.commands configured in .nax/config.json — nax-finish verified nothing.");
  });

  test("a failing run under the fix cap routes fix", () => {
    const r = routeQualityGates(passedResult({ passed: false, failing: ["test"] }), zeroedState());
    expect(r.route).toBe("fix");
  });

  test("a failing run past the fix cap stops with the byte-identical reason", () => {
    const st = { ...zeroedState(), fixAttempts: MAX_FIX_ATTEMPTS };
    const r = routeQualityGates(passedResult({ passed: false, failing: ["test"] }), st);
    expect(r.route).toBe("stop");
    expect(r.reason).toBe(`Quality gates still failing after ${MAX_FIX_ATTEMPTS} fix attempts (test).`);
  });
});

describe("gateFacts", () => {
  test("one entry per gate that ran: failing is red with the output, the rest green", () => {
    const facts = gateFacts({ passed: false, ran: ["lint", "test"], failing: ["test"], output: "boom" });
    expect(facts).toEqual([
      { name: "lint", status: "green" },
      { name: "test", status: "red", excerpt: "boom" },
    ]);
  });

  test("nothing ran is one red quality.commands entry, even when the result says passed", () => {
    expect(gateFacts({ passed: true, ran: [], failing: [], output: "" })).toEqual([
      { name: "quality.commands", status: "red", excerpt: "No quality.commands configured" },
    ]);
  });
});

describe("MAX_REVIEW_ROUNDS", () => {
  test("is three", () => {
    expect(MAX_REVIEW_ROUNDS).toBe(3);
  });
});

describe("partitionTestFiles", () => {
  test("with no patterns, everything classifies as non-test", () => {
    const r = partitionTestFiles(["src/a.ts", "test/unit/a.test.ts"], []);
    expect(r.test).toEqual([]);
    expect(r.nonTest).toEqual(["src/a.ts", "test/unit/a.test.ts"]);
  });

  test("classifies matched paths as test, the rest as non-test", () => {
    const r = partitionTestFiles(["src/a.ts", "test/unit/a.test.ts"], ["\\.test\\.ts$"]);
    expect(r.test).toEqual(["test/unit/a.test.ts"]);
    expect(r.nonTest).toEqual(["src/a.ts"]);
  });

  test("skips an unparseable regex source rather than throwing", () => {
    expect(() => partitionTestFiles(["src/a.ts"], ["("])).not.toThrow();
    const r = partitionTestFiles(["src/a.ts"], ["("]);
    expect(r.nonTest).toEqual(["src/a.ts"]);
  });
});

describe("gateCommitRoute", () => {
  test("nothing committed is unchanged", () => {
    expect(gateCommitRoute(false, [], [])).toBe("unchanged");
  });

  test("an unresolvable post-commit SHA (null files) is changed", () => {
    expect(gateCommitRoute(true, null, [])).toBe("changed");
  });

  test("a committed change with an empty file list is changed", () => {
    expect(gateCommitRoute(true, [], [])).toBe("changed");
  });

  test("every touched path matching a test pattern is tests-only", () => {
    expect(gateCommitRoute(true, ["test/unit/a.test.ts"], ["\\.test\\.ts$"])).toBe("tests-only");
  });

  test("any non-test path in the commit is changed", () => {
    expect(gateCommitRoute(true, ["src/a.ts", "test/unit/a.test.ts"], ["\\.test\\.ts$"])).toBe("changed");
  });

  test("with no test patterns, a committed change cannot be classified and is changed", () => {
    expect(gateCommitRoute(true, ["test/unit/a.test.ts"], [])).toBe("changed");
  });
});
