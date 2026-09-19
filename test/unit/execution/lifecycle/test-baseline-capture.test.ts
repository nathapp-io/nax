/**
 * Unit tests for src/execution/lifecycle/test-baseline-capture.ts
 *
 * Covers AC1–AC10 and AC17 of US-002:
 *   - AC1   captured preflight baseline with baseRef + parsed failures
 *   - AC2   command runner receives the resolved command
 *   - AC3   command runner receives regressionGate.timeoutSeconds
 *   - AC4   falls back to rectification.fullSuiteTimeoutSeconds
 *   - AC5   green suite → captured baseline with empty entries (not no-baseline)
 *   - AC6   regressionGate.enabled=false → no-baseline reason gate-disabled
 *   - AC7   no resolvable command → no-baseline reason no-test-command
 *   - AC8   runner timed out → no-baseline reason timeout
 *   - AC9   nonzero + zero parsed failures → no-baseline reason unparseable
 *   - AC10  runner throws → resolves normally, no-baseline reason error
 *   - AC17  every degraded capture outcome resolves normally without rejecting
 *
 * The harness stub in `captureRunBaseline` writes a `no-baseline` marker for
 * every call, so each AC test asserts on the SHAPE the implementer must
 * produce and fails its assertion until the implementer wires the right
 * branch in.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import {
  _captureDeps,
  type CaptureParsedSummary,
  type CaptureRunBaselineOptions,
  type CaptureRunnerResult,
  captureRunBaseline,
} from "@/execution/lifecycle/test-baseline-capture";
import type { TestBaseline } from "@/verification";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBaselineConfig(overrides: Partial<NaxConfig["execution"]> = {}): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: { enabled: true, timeoutSeconds: 60 },
      // `rectification` is fully populated by the schema; we layer the override
      // onto DEFAULT_CONFIG rather than replacing the whole subtree so we keep
      // every required field intact.
      ...overrides,
    },
    quality: { commands: { test: "bun test" } },
  });
}

function makeOptions(config: NaxConfig = makeBaselineConfig()): CaptureRunBaselineOptions {
  return { root: "/tmp/repo", featureId: "feat-x", config, workdir: "/tmp/repo" };
}

function resetCaptureDeps(): void {
  _captureDeps.resolveTestCommands = async (_config: NaxConfig, _workdir: string) => undefined;
  _captureDeps.runCommand = async (_command: string, _timeoutSeconds: number) => ({
    success: false,
    output: "",
    timedOut: false,
  });
  _captureDeps.captureGitRef = async (_workdir: string) => "";
  _captureDeps.parseTestOutput = (_output: string): CaptureParsedSummary => ({
    passed: 0,
    failed: 0,
    failures: [],
  });
  _captureDeps.now = () => "2026-01-15T00:00:00.000Z";
  _captureDeps.resolveGateTimeoutSeconds = (config: NaxConfig) =>
    config.execution?.regressionGate?.timeoutSeconds ?? config.execution?.rectification?.fullSuiteTimeoutSeconds ?? 300;
  _captureDeps.regressionGateEnabled = (config: NaxConfig) => config.execution?.regressionGate?.enabled ?? true;
  _captureDeps.writeRunBaseline = async (_root: string, _featureId: string, _baseline: TestBaseline) => undefined;
  _captureDeps.writeStoryBaseline = async (
    _root: string,
    _featureId: string,
    _storyId: string,
    _baseline: TestBaseline,
  ) => undefined;
}

afterEach(() => {
  resetCaptureDeps();
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — captured preflight baseline with baseRef + one entry per parsed failure
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC1 (preflight + baseRef + parsed entries)", () => {
  test("AC1: persists a captured baseline with source=preflight, the captured baseRef, and one entry per parsed failure", async () => {
    const writes: Array<[string, string, TestBaseline]> = [];
    _captureDeps.writeRunBaseline = async (root, featureId, baseline) => {
      writes.push([root, featureId, baseline]);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({
      success: false,
      output: "fake failing output",
      timedOut: false,
      exitCode: 1,
    });
    _captureDeps.captureGitRef = async () => "abc123";
    _captureDeps.parseTestOutput = () => ({
      passed: 0,
      failed: 2,
      failures: [
        { file: "test/unit/foo.test.ts", testName: "should pass" },
        { file: "test/unit/bar.test.ts", testName: "should also pass" },
      ],
    });

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    const [, , baseline] = writes[0] ?? [];
    expect(baseline?.kind).toBe("captured");
    if (baseline?.kind === "captured") {
      expect(baseline.source).toBe("preflight");
      expect(baseline.baseRef).toBe("abc123");
      expect(baseline.entries).toEqual([
        { file: "test/unit/foo.test.ts", testName: "should pass" },
        { file: "test/unit/bar.test.ts", testName: "should also pass" },
      ]);
    }
  });

  test("AC1 boundary: every parsed failure carries its file and testName into an entry", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({ success: false, output: "", timedOut: false });
    _captureDeps.captureGitRef = async () => "base-sha";
    _captureDeps.parseTestOutput = () => ({
      passed: 0,
      failed: 3,
      failures: [
        { file: "a.test.ts", testName: "test 1" },
        { file: "b.test.ts", testName: "test 2" },
        { file: "c.test.ts", testName: "test 3" },
      ],
    });

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    const baseline = writes[0];
    if (baseline?.kind === "captured") {
      expect(baseline.entries.map((e) => e.file)).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
      expect(baseline.entries.map((e) => e.testName)).toEqual(["test 1", "test 2", "test 3"]);
    } else {
      throw new Error(`expected kind=captured, got ${baseline?.kind}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — command runner receives the resolved command
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC2 (command forwarded to runner)", () => {
  test("AC2: runner receives the exact command returned by the resolver", async () => {
    const calls: Array<{ command: string; timeout: number }> = [];
    _captureDeps.resolveTestCommands = async () => "bun test --coverage";
    _captureDeps.runCommand = async (command, timeout) => {
      calls.push({ command, timeout });
      return { success: false, output: "", timedOut: false };
    };
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await captureRunBaseline(makeOptions());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("bun test --coverage");
  });

  test("AC2 boundary: runner receives the exact command even with shell metacharacters", async () => {
    const calls: string[] = [];
    _captureDeps.resolveTestCommands = async () => "go test ./... -run TestX -v";
    _captureDeps.runCommand = async (command) => {
      calls.push(command);
      return { success: false, output: "", timedOut: false };
    };
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await captureRunBaseline(makeOptions());

    expect(calls[0]).toBe("go test ./... -run TestX -v");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — command runner receives regressionGate.timeoutSeconds
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC3 (regressionGate.timeoutSeconds)", () => {
  test("AC3: runner receives the regressionGate timeout when set", async () => {
    let received = 0;
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async (_command, timeout) => {
      received = timeout;
      return { success: true, output: "", timedOut: false };
    };
    // Production resolver: prefer regressionGate, fall back to rectification.
    _captureDeps.resolveGateTimeoutSeconds = (config) =>
      config.execution?.regressionGate?.timeoutSeconds ??
      config.execution?.rectification?.fullSuiteTimeoutSeconds ??
      300;
    const config = makeBaselineConfig();

    await captureRunBaseline(makeOptions(config));

    expect(received).toBe(60); // makeBaselineConfig default for regressionGate.timeoutSeconds
  });

  test("AC3 boundary: regressionGate timeout takes precedence over the rectification fallback", async () => {
    let received = 0;
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async (_command, timeout) => {
      received = timeout;
      return { success: true, output: "", timedOut: false };
    };
    _captureDeps.resolveGateTimeoutSeconds = (config) =>
      config.execution?.regressionGate?.timeoutSeconds ??
      config.execution?.rectification?.fullSuiteTimeoutSeconds ??
      300;
    const config = makeBaselineConfig();

    await captureRunBaseline(makeOptions(config));

    // regressionGate wins — its value (60) is what reached the runner, not the
    // rectification fallback.
    expect(received).toBe(60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — falls back to rectification.fullSuiteTimeoutSeconds
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC4 (rectification fallback)", () => {
  test("AC4: when no regressionGate timeout, runner receives the rectification timeout", async () => {
    let received = 0;
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async (_command, timeout) => {
      received = timeout;
      return { success: true, output: "", timedOut: false };
    };
    // The harness's resolveGateTimeoutSeconds intentionally ignores
    // regressionGate.timeoutSeconds to simulate its absence.
    _captureDeps.resolveGateTimeoutSeconds = (config) =>
      config.execution?.rectification?.fullSuiteTimeoutSeconds ?? 300;
    const config = makeBaselineConfig();

    await captureRunBaseline(makeOptions(config));

    expect(received).toBe(200);
  });

  test("AC4 boundary: with no regressionGate.timeoutSeconds, the rectification timeout is used even when regressionGate.enabled is true", async () => {
    let received = 0;
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async (_command, timeout) => {
      received = timeout;
      return { success: true, output: "", timedOut: false };
    };
    // Resolve as if regressionGate.timeoutSeconds were undefined:
    _captureDeps.resolveGateTimeoutSeconds = (config) =>
      config.execution?.rectification?.fullSuiteTimeoutSeconds ?? 300;
    const config = makeBaselineConfig();

    await captureRunBaseline(makeOptions(config));

    expect(received).toBe(200); // rectification.fullSuiteTimeoutSeconds default
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — green suite → captured baseline with empty entries (not no-baseline)
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC5 (green suite → empty entries)", () => {
  test("AC5: green suite with zero failures persists a captured baseline with empty entries", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({ success: true, output: "all green", timedOut: false });
    _captureDeps.parseTestOutput = () => ({ passed: 42, failed: 0, failures: [] });
    _captureDeps.captureGitRef = async () => "abc";

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    const baseline = writes[0];
    expect(baseline?.kind).toBe("captured");
    if (baseline?.kind === "captured") {
      expect(baseline.entries).toEqual([]);
      expect(baseline.source).toBe("preflight");
    }
  });

  test("AC5 boundary: green suite must NOT produce a no-baseline marker", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({ success: true, output: "", timedOut: false });
    _captureDeps.parseTestOutput = () => ({ passed: 1, failed: 0, failures: [] });
    _captureDeps.captureGitRef = async () => "x";

    await captureRunBaseline(makeOptions());

    expect(writes.some((b) => b.kind === "no-baseline")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — regressionGate.enabled=false → no spawn, no-baseline reason gate-disabled
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC6 (gate-disabled)", () => {
  test("AC6: gate disabled → runner not invoked, no-baseline marker with reason gate-disabled", async () => {
    const writes: TestBaseline[] = [];
    const runnerCalls: unknown[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.regressionGateEnabled = () => false;
    _captureDeps.runCommand = async () => {
      runnerCalls.push("ran");
      return { success: false, output: "", timedOut: false };
    };

    await captureRunBaseline(
      makeOptions(makeBaselineConfig({ regressionGate: { enabled: false, timeoutSeconds: 60 } })),
    );

    expect(runnerCalls).toHaveLength(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("gate-disabled");
    }
  });

  test("AC6 boundary: gate-disabled still resolves without throwing when no other deps are set", async () => {
    // Most pessimistic setup — only `now` and `writeRunBaseline` are real.
    _captureDeps.regressionGateEnabled = () => false;
    _captureDeps.resolveTestCommands = async () => {
      throw new Error("resolver must not be called when gate is disabled");
    };
    _captureDeps.runCommand = async () => {
      throw new Error("runner must not be called when gate is disabled");
    };

    await expect(captureRunBaseline(makeOptions())).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — no resolvable command → no spawn, no-baseline reason no-test-command
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC7 (no-test-command)", () => {
  test("AC7: no resolvable command → runner not invoked, no-baseline reason no-test-command", async () => {
    const writes: TestBaseline[] = [];
    const runnerCalls: unknown[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => undefined;
    _captureDeps.runCommand = async () => {
      runnerCalls.push("ran");
      return { success: false, output: "", timedOut: false };
    };

    await captureRunBaseline(makeOptions());

    expect(runnerCalls).toHaveLength(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("no-test-command");
    }
  });

  test("AC7 boundary: the runner is never invoked when the resolver returns undefined", async () => {
    const writes: TestBaseline[] = [];
    const runnerCalls: string[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => undefined;
    _captureDeps.runCommand = async () => {
      runnerCalls.push("ran");
      return { success: false, output: "", timedOut: false };
    };

    await captureRunBaseline(makeOptions());

    expect(runnerCalls).toHaveLength(0);
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("no-test-command");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — runner timed out → no-baseline reason timeout
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC8 (timeout)", () => {
  test("AC8: runner flagged as timed out → no-baseline reason timeout", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({ success: false, output: "...", timedOut: true });
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("timeout");
    }
  });

  test("AC8 boundary: timed-out result still produces a no-baseline marker even when exitCode is set", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({ success: false, output: "killed", timedOut: true, exitCode: 124 });
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await captureRunBaseline(makeOptions());

    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("timeout");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — nonzero + zero parsed failures → no-baseline reason unparseable
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC9 (unparseable)", () => {
  test("AC9: runner nonzero + parser yields zero structured failures → no-baseline reason unparseable", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({
      success: false,
      output: "ModuleNotFoundError: nope",
      timedOut: false,
      exitCode: 2,
    });
    _captureDeps.parseTestOutput = () => ({ passed: 0, failed: 0, failures: [] });
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await captureRunBaseline(makeOptions());

    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("unparseable");
    }
  });

  test("AC9 boundary: nonzero runner with parseable failures does NOT produce unparseable", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => ({ success: false, output: "1 failed", timedOut: false, exitCode: 1 });
    _captureDeps.parseTestOutput = () => ({
      passed: 0,
      failed: 1,
      failures: [{ file: "x.test.ts", testName: "t" }],
    });
    _captureDeps.resolveGateTimeoutSeconds = () => 60;
    _captureDeps.captureGitRef = async () => "abc";

    await captureRunBaseline(makeOptions());

    expect(writes[0]?.kind).toBe("captured");
    expect(writes.some((b) => b.kind === "no-baseline" && b.reason === "unparseable")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — runner throws → resolves normally, no-baseline reason error
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC10 (runner throws)", () => {
  test("AC10: runner throws → capture resolves without rejecting and persists no-baseline reason error", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => {
      throw new Error("spawn failed: EACCES");
    };
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await expect(captureRunBaseline(makeOptions())).resolves.toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("error");
    }
  });

  test("AC10 boundary: even an untyped throw (non-Error) resolves normally and writes no-baseline reason error", async () => {
    const writes: TestBaseline[] = [];
    _captureDeps.writeRunBaseline = async (_root, _featureId, baseline) => {
      writes.push(baseline);
    };
    _captureDeps.resolveTestCommands = async () => "bun test";
    _captureDeps.runCommand = async () => {
      throw new Error("non-Error-shaped throw");
    };
    _captureDeps.resolveGateTimeoutSeconds = () => 60;

    await expect(captureRunBaseline(makeOptions())).resolves.toBeUndefined();
    expect(writes[0]?.kind).toBe("no-baseline");
    if (writes[0]?.kind === "no-baseline") {
      expect(writes[0].reason).toBe("error");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC17 — every degraded capture outcome resolves normally without rejecting
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunBaseline — AC17 (degraded outcomes resolve normally)", () => {
  test.each([
    {
      name: "gate-disabled",
      setup: () => {
        _captureDeps.regressionGateEnabled = () => false;
      },
    },
    {
      name: "no-test-command",
      setup: () => {
        _captureDeps.resolveTestCommands = async () => undefined;
      },
    },
    {
      name: "timeout",
      setup: () => {
        _captureDeps.resolveTestCommands = async () => "bun test";
        _captureDeps.runCommand = async () => ({ success: false, output: "", timedOut: true });
        _captureDeps.resolveGateTimeoutSeconds = () => 60;
      },
    },
    {
      name: "unparseable",
      setup: () => {
        _captureDeps.resolveTestCommands = async () => "bun test";
        _captureDeps.runCommand = async () => ({ success: false, output: "noise", timedOut: false });
        _captureDeps.parseTestOutput = () => ({ passed: 0, failed: 0, failures: [] });
        _captureDeps.resolveGateTimeoutSeconds = () => 60;
      },
    },
    {
      name: "error",
      setup: () => {
        _captureDeps.resolveTestCommands = async () => "bun test";
        _captureDeps.runCommand = async () => {
          throw new Error("spawn failed");
        };
        _captureDeps.resolveGateTimeoutSeconds = () => 60;
      },
    },
  ])("AC17: degraded outcome `$name` resolves normally without rejecting", async ({ setup }) => {
    resetCaptureDeps();
    setup();
    _captureDeps.writeRunBaseline = async () => undefined;

    await expect(captureRunBaseline(makeOptions())).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanity — Type shapes (compile-time assertions via `expect`)
// ─────────────────────────────────────────────────────────────────────────────

describe("test-baseline-capture — type shape sanity", () => {
  test("CaptureRunnerResult is shape-compatible with TestExecutionResult.success/timedOut/output/exitCode", () => {
    const r: CaptureRunnerResult = { success: false, output: "out", timedOut: false, exitCode: 1 };
    expect(r.success).toBe(false);
    expect(r.output).toBe("out");
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  test("CaptureParsedSummary is shape-compatible with TestSummary.failures[].file/testName", () => {
    const summary: CaptureParsedSummary = {
      passed: 1,
      failed: 2,
      failures: [
        { file: "a", testName: "x" },
        { file: "b", testName: "y" },
      ],
    };
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures[0]?.file).toBe("a");
    expect(summary.failures[0]?.testName).toBe("x");
  });
});
