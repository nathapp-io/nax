/**
 * Direct unit tests for `warnQualityCommandChains` (nax#1990) — the
 * config-guards.ts wiring function that calls collectCommandChainWarnings on
 * the raw, pre-safeParse `quality.commands` slice of a config object.
 *
 * These pin the malformed-input contract explicitly (rather than relying on
 * an unrelated pre-existing test — loader-schema-error.test.ts — happening
 * not to crash), since this function runs on config that hasn't been
 * Zod-validated yet.
 */

import { describe, expect, it, test } from "bun:test";
import * as guards from "@/config/config-guards";
import { rejectRemovedPlanModes, warnQualityCommandChains, warnScopedTestCommand } from "@/config/config-guards";
import { NaxError } from "@/errors";

describe("warnQualityCommandChains", () => {
  test("warns via the sink for a chained string command", () => {
    const captured: string[] = [];
    warnQualityCommandChains({ quality: { commands: { typecheck: "a && b" } } }, (msg) => captured.push(msg));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain("typecheck");
  });

  test("is silent for a clean list command", () => {
    const captured: string[] = [];
    warnQualityCommandChains({ quality: { commands: { typecheck: ["a", "b"] } } }, (msg) => captured.push(msg));

    expect(captured).toEqual([]);
  });

  test("is silent when there is no quality section", () => {
    const captured: string[] = [];
    warnQualityCommandChains({ execution: {} }, (msg) => captured.push(msg));

    expect(captured).toEqual([]);
  });

  test("is silent when quality is not an object", () => {
    const captured: string[] = [];
    expect(() => warnQualityCommandChains({ quality: 42 }, (msg) => captured.push(msg))).not.toThrow();

    expect(captured).toEqual([]);
  });

  test("does not throw and is silent for a non-string, non-array command value", () => {
    // Raw pre-safeParse config: `commands.test: 42` — the exact shape
    // exercised by test/unit/config/loader-schema-error.test.ts through the
    // full loadConfig path. Pinned directly here too.
    const commands = JSON.parse('{"quality": {"commands": {"test": 42}}}');
    const captured: string[] = [];
    expect(() => warnQualityCommandChains(commands, (msg) => captured.push(msg))).not.toThrow();

    expect(captured).toEqual([]);
  });

  test("does not throw and is silent for a mixed-type array command value", () => {
    const commands = JSON.parse('{"quality": {"commands": {"test": ["ok", 42]}}}');
    const captured: string[] = [];
    expect(() => warnQualityCommandChains(commands, (msg) => captured.push(msg))).not.toThrow();

    expect(captured).toEqual([]);
  });

  test("does nothing when warn is omitted", () => {
    expect(() => warnQualityCommandChains({ quality: { commands: { lint: "a && b" } } })).not.toThrow();
  });
});

describe("warnScopedTestCommand (US-006)", () => {
  /** The messages the sink received, in order. */
  function warningsFor(conf: Record<string, unknown>): string[] {
    const captured: string[] = [];
    warnScopedTestCommand(conf, (msg) => captured.push(msg));
    return captured;
  }

  test("AC-4: a testScoped command with no {{files}} placeholder warns once, naming the placeholder", () => {
    const messages = warningsFor({
      quality: { commands: { testScoped: "npx turbo test --filter=[HEAD^1]" } },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("declares no {{files}} placeholder");
  });

  test("AC-5: a testScoped command equal to the test command warns that every scoped run is the full suite", () => {
    const messages = warningsFor({ quality: { commands: { test: "pytest -q", testScoped: "pytest -q" } } });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("equals quality.commands.test");
  });

  test("AC-6: a list where one entry carries {{files}} is silent", () => {
    expect(warningsFor({ quality: { commands: { testScoped: ["tsc --noEmit", "bun test {{files}}"] } } })).toEqual([]);
  });

  test("AC-7: is silent when no testScoped command is declared", () => {
    expect(warningsFor({ quality: { commands: { test: "bun test" } } })).toEqual([]);
    expect(warningsFor({ quality: {} })).toEqual([]);
    expect(warningsFor({})).toEqual([]);
  });

  test("checks a list across its entries: every entry without the placeholder still warns", () => {
    const messages = warningsFor({ quality: { commands: { testScoped: ["tsc --noEmit", "npm run e2e"] } } });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("declares no {{files}} placeholder");
  });

  test("is silent for a malformed spec, leaving it to Zod validation", () => {
    const conf = JSON.parse('{"quality": {"commands": {"testScoped": 42}}}');

    expect(() => warnScopedTestCommand(conf, () => {})).not.toThrow();
    expect(warningsFor(conf)).toEqual([]);
  });

  test("does nothing when warn is omitted", () => {
    expect(() =>
      warnScopedTestCommand({ quality: { commands: { testScoped: "npx turbo test --filter=[HEAD^1]" } } }),
    ).not.toThrow();
  });

  // US-007 — a turbo/nx orchestrator takes no test paths at all, so telling the
  // user to "add {{files}}" is advice that cannot be followed. Only the
  // declared `quality.commands.test` establishes the exemption; equality stays
  // the highest-priority warning, so an orchestrator whose testScoped repeats
  // the full-suite command still warns.

  test("AC-3: is silent when the test command is a turbo orchestrator", () => {
    expect(
      warningsFor({
        quality: { commands: { test: "npx turbo test", testScoped: "npx turbo test --filter=[HEAD^1]" } },
      }),
    ).toEqual([]);
  });

  test("AC-4: is silent when the test command is an nx orchestrator", () => {
    expect(
      warningsFor({
        quality: { commands: { test: "nx affected -t test", testScoped: "nx affected -t test --base=HEAD~1" } },
      }),
    ).toEqual([]);
  });

  test("AC-5: an orchestrator testScoped equal to the test command still warns about equality", () => {
    const messages = warningsFor({
      quality: { commands: { test: "npx turbo test", testScoped: "npx turbo test" } },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("equals quality.commands.test");
    expect(messages[0]).toContain("every scoped run is the full suite");
  });

  test("AC-6: a non-orchestrator test command keeps the {{files}} warning", () => {
    const messages = warningsFor({ quality: { commands: { test: "bun test", testScoped: "bun test --bail" } } });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("declares no {{files}} placeholder");
  });

  test("AC-7: an orchestrator testScoped alone still warns when no test command is declared", () => {
    const messages = warningsFor({
      quality: { commands: { testScoped: "npx turbo test --filter=[HEAD^1]" } },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("declares no {{files}} placeholder");
  });

  test("keys the exemption off the declared test command, not the testScoped command", () => {
    const messages = warningsFor({
      quality: { commands: { test: "bun test", testScoped: "npx turbo test --filter=[HEAD^1]" } },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("declares no {{files}} placeholder");
  });
});

describe("rejectRemovedPlanModes", () => {
  it.each(["pipeline", "debate"])("throws on plan.mode: %s", (mode) => {
    expect(() => rejectRemovedPlanModes({ plan: { mode } })).toThrow(/plan\.mode/);
  });

  it("names the surviving modes in the message", () => {
    expect(() => rejectRemovedPlanModes({ plan: { mode: "pipeline" } })).toThrow(/single.*refine|refine.*single/s);
  });

  it.each(["single", "refine"])("accepts the surviving mode %s", (mode) => {
    expect(() => rejectRemovedPlanModes({ plan: { mode } })).not.toThrow();
  });

  it("is a no-op when plan or plan.mode is absent", () => {
    expect(() => rejectRemovedPlanModes({})).not.toThrow();
    expect(() => rejectRemovedPlanModes({ plan: {} })).not.toThrow();
  });
});

describe("rejectPipelineModeKeys", () => {
  function rejected(execution: Record<string, unknown>, source = "project config"): NaxError {
    try {
      guards.rejectPipelineModeKeys({ execution }, source);
    } catch (err) {
      if (err instanceof NaxError) return err;
      throw err;
    }
    throw new Error("Expected removed pipeline keys to be rejected");
  }

  test("AC-1 rejects pipeline mode with structured context", () => {
    const err = rejected({ mode: "pipeline" });
    expect(err.code).toBe("CONFIG_PIPELINE_MODE_REMOVED");
    expect(err.context).toEqual({ stage: "config", source: "project config", keys: ["execution.mode"] });
  });

  test("AC-2 lists both keys in canonical order with exact migration hints", () => {
    expect(rejected({ mode: "pipeline", maxIterations: 5 }).message).toBe(
      [
        "Invalid configuration in project config — pipeline mode was removed: execution.mode, execution.maxIterations.",
        "Workflow mode is the only execution mode, and it bounds a run by its stories.",
        '- execution.mode: remove it, or set it to "workflow".',
        "- execution.maxIterations: remove it.",
      ].join("\n"),
    );
  });

  test("AC-3 names only maxIterations and the source", () => {
    const err = rejected({ maxIterations: 5 }, "global config");
    expect(err.message).toContain(
      "Invalid configuration in global config — pipeline mode was removed: execution.maxIterations.",
    );
    expect(err.context?.keys).toEqual(["execution.maxIterations"]);
    expect(err.message).not.toContain("- execution.mode:");
  });

  test.each([{ execution: { mode: "workflow" } }, { execution: {} }, {}, { execution: "x" }, { execution: null }])(
    "AC-4 accepts unaffected raw layer %j",
    (layer) => {
      expect(() => guards.rejectPipelineModeKeys(layer, "project config")).not.toThrow();
    },
  );

  test.each([undefined, null, false, "x", 0])("rejects own maxIterations with value %j", (value) => {
    expect(rejected({ maxIterations: value }).code).toBe("CONFIG_PIPELINE_MODE_REMOVED");
  });

  test("ignores inherited maxIterations", () => {
    expect(() =>
      guards.rejectPipelineModeKeys({ execution: Object.create({ maxIterations: 5 }) }, "project config"),
    ).not.toThrow();
  });
});
