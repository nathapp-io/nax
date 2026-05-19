import { describe, expect, test } from "bun:test";
import { fullSuiteGateOp } from "@/operations";
import type { FullSuiteGateStatus } from "@/operations";
import { makeNaxConfig } from "@test/helpers";

const makeCtx = (rectificationEnabled: boolean) => ({
  packageView: {} as any,
  config: makeNaxConfig({ execution: { rectification: { enabled: rectificationEnabled } } }),
});

const input = {
  story: { id: "US-001" } as any,
  workdir: "/tmp/test",
};

describe("fullSuiteGateOp — RunOperation shape", () => {
  test("exports as a RunOperation with kind=run", () => {
    expect(fullSuiteGateOp).toBeDefined();
    expect(fullSuiteGateOp.kind).toBe("run");
  });

  test("name is full-suite-gate", () => {
    expect(fullSuiteGateOp.name).toBe("full-suite-gate");
  });

  test("session role is main and lifetime is fresh", () => {
    expect(fullSuiteGateOp.session.role).toBe("main");
    expect(fullSuiteGateOp.session.lifetime).toBe("fresh");
  });

  test("has build and parse functions", () => {
    expect(typeof fullSuiteGateOp.build).toBe("function");
    expect(typeof fullSuiteGateOp.parse).toBe("function");
  });
});

describe("fullSuiteGateOp.parse — disabled config (AC4)", () => {
  test("returns status=disabled with success=false when rectification is disabled", () => {
    const result = fullSuiteGateOp.parse('{"status":"passed","passed":true}', input, makeCtx(false));
    expect(result.status).toBe("disabled");
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("returns attempts=0 when rectification is disabled", () => {
    const result = fullSuiteGateOp.parse("{}", input, makeCtx(false));
    expect(result.attempts).toBe(0);
  });

  test("returns cost=0 when rectification is disabled", () => {
    const result = fullSuiteGateOp.parse("{}", input, makeCtx(false));
    expect(result.cost).toBe(0);
  });

  test("ignores agent output when rectification is disabled", () => {
    const result = fullSuiteGateOp.parse('{"status":"passed","passed":true,"cost":9.99}', input, makeCtx(false));
    expect(result.status).toBe("disabled");
    expect(result.cost).toBe(0);
  });
});

describe("fullSuiteGateOp.parse — passed status (AC3)", () => {
  test("returns status=passed with success=true when agent reports passed", () => {
    const output = JSON.stringify({ status: "passed", passed: true, cost: 0.05 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.status).toBe("passed");
    expect(result.success).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.cost).toBe(0.05);
  });

  test("includes attempts when provided", () => {
    const output = JSON.stringify({ status: "passed", passed: true, cost: 0.1, attempts: 2 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.attempts).toBe(2);
  });

  test("omits attempts when not provided", () => {
    const output = JSON.stringify({ status: "passed", passed: true, cost: 0.1 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.attempts).toBeUndefined();
  });
});

describe("fullSuiteGateOp.parse — rectification-exhausted status (AC3)", () => {
  test("returns success=false when rectification exhausted", () => {
    const output = JSON.stringify({ status: "rectification-exhausted", passed: false, cost: 0.8, attempts: 3 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.status).toBe("rectification-exhausted");
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.cost).toBe(0.8);
    expect(result.attempts).toBe(3);
  });
});

describe("fullSuiteGateOp.parse — execution-failed status (AC5)", () => {
  test("returns status=execution-failed with success=false", () => {
    const output = JSON.stringify({ status: "execution-failed", passed: false, cost: 0 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.status).toBe("execution-failed");
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("fullSuiteGateOp.parse — inconclusive status (AC6)", () => {
  test("returns status=inconclusive with success=false on unparseable output", () => {
    const result = fullSuiteGateOp.parse("not json", input, makeCtx(true));
    expect(result.status).toBe("inconclusive");
    expect(result.success).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("returns status=inconclusive with success=false on empty output", () => {
    const result = fullSuiteGateOp.parse("", input, makeCtx(true));
    expect(result.status).toBe("inconclusive");
    expect(result.success).toBe(false);
  });

  test("returns status=inconclusive when agent returns unknown status string", () => {
    const output = JSON.stringify({ status: "unknown-status", passed: false, cost: 0 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.status).toBe("inconclusive");
    expect(result.success).toBe(false);
  });

  test("returns status=inconclusive when agent returns explicit inconclusive status", () => {
    const output = JSON.stringify({ status: "inconclusive", passed: false, cost: 0 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.status).toBe("inconclusive");
    expect(result.success).toBe(false);
  });
});

describe("fullSuiteGateOp.parse — all valid status types (AC3)", () => {
  const statuses: FullSuiteGateStatus[] = [
    "passed",
    "rectification-exhausted",
    "disabled",
    "execution-failed",
    "inconclusive",
  ];

  for (const status of statuses) {
    test(`accepts status='${status}'`, () => {
      const output = JSON.stringify({ status, passed: status === "passed", cost: 0 });
      const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
      expect(result.status).toBe(status);
    });
  }
});

describe("fullSuiteGateOp.parse — success semantics", () => {
  test("success=true only when status=passed and passed=true", () => {
    const output = JSON.stringify({ status: "passed", passed: true, cost: 0 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.success).toBe(true);
  });

  test("success=false when passed=false even if status=passed", () => {
    const output = JSON.stringify({ status: "passed", passed: false, cost: 0 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.success).toBe(false);
  });

  test("success=false when status=rectification-exhausted", () => {
    const output = JSON.stringify({ status: "rectification-exhausted", passed: false, cost: 0.5 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.success).toBe(false);
  });
});

describe("fullSuiteGateOp.parse — cost extraction", () => {
  test("extracts numeric cost from agent output", () => {
    const output = JSON.stringify({ status: "passed", passed: true, cost: 1.234 });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.cost).toBe(1.234);
  });

  test("defaults cost to 0 when missing from agent output", () => {
    const output = JSON.stringify({ status: "passed", passed: true });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.cost).toBe(0);
  });

  test("defaults cost to 0 when cost is non-numeric", () => {
    const output = JSON.stringify({ status: "passed", passed: true, cost: "expensive" });
    const result = fullSuiteGateOp.parse(output, input, makeCtx(true));
    expect(result.cost).toBe(0);
  });
});
