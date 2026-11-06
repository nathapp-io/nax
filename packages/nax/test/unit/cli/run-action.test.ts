import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import chalk from "chalk";
// biome-ignore lint/style/noRestrictedImports: CLI entry helpers live in bin/, outside the @/ source alias.
import { applyRunCliOverrides, parseRunPreconditionFlags, type RunActionOptions } from "../../../bin/run-action";

function options(overrides: Partial<RunActionOptions> = {}): RunActionOptions {
  return { feature: "demo", dir: "/tmp", dryRun: false, ...overrides };
}

const maxMessage = "nax run -m/--max-iterations was removed: workflow mode bounds a run by its stories";
const parallelMessage = "nax run --parallel was removed: workflow mode runs stories one at a time";
const noBatchMessage = "nax run --no-batch was removed: workflow mode runs stories one at a time";

describe("parseRunPreconditionFlags", () => {
  const exitError = new Error("exit");
  let stderr: ReturnType<typeof spyOn<typeof console, "error">>;
  let exit: ReturnType<typeof spyOn<typeof process, "exit">>;
  const colorLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 1;
    stderr = spyOn(console, "error").mockImplementation(() => {});
    exit = spyOn(process, "exit").mockImplementation(() => {
      throw exitError;
    });
  });
  afterEach(() => {
    stderr.mockRestore();
    exit.mockRestore();
    chalk.level = colorLevel;
  });

  test.each([
    ["AC-1", { maxIterations: "5" }, maxMessage],
    ["AC-2", { parallel: "2" }, parallelMessage],
    ["AC-3", { maxIterations: "5", parallel: "2" }, maxMessage],
    ["defined empty -m", { maxIterations: "" }, maxMessage],
    ["defined empty parallel", { parallel: "" }, parallelMessage],
  ])("%s: rejects removed flags in order with red stderr and exit 1", (_name, flags, message) => {
    expect(() => parseRunPreconditionFlags(options(flags))).toThrow(exitError);
    expect(stderr.mock.calls).toEqual([[`\u001b[31m${message}\u001b[39m`]]);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  // US-001 AC-1 / AC-2: --no-batch is a removal message, not a silent no-op.
  test("US-001 AC-1 + AC-2: --no-batch prints the removal message in red once and exits 1", () => {
    expect(() => parseRunPreconditionFlags(options({ batch: false }))).toThrow(exitError);
    expect(stderr.mock.calls).toEqual([[`\u001b[31m${noBatchMessage}\u001b[39m`]]);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  // US-001 AC-3 / AC-4: the --parallel check keeps precedence over --no-batch.
  test("US-001 AC-3 + AC-4: --parallel wins over --no-batch, exiting 1 on the --parallel message", () => {
    expect(() => parseRunPreconditionFlags(options({ batch: false, parallel: "2" }))).toThrow(exitError);
    expect(stderr.mock.calls).toEqual([[`\u001b[31m${parallelMessage}\u001b[39m`]]);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  // US-001 AC-11: -m keeps precedence over both --parallel and --no-batch.
  test("US-001 AC-11: -m wins over --parallel and --no-batch", () => {
    expect(() => parseRunPreconditionFlags(options({ maxIterations: "5", parallel: "2", batch: false }))).toThrow(
      exitError,
    );
    expect(stderr.mock.calls).toEqual([[`\u001b[31m${maxMessage}\u001b[39m`]]);
    expect(exit.mock.calls).toEqual([[1]]);
  });

  test("does not reject batch: true (commander's --no-batch default)", () => {
    expect(parseRunPreconditionFlags(options({ batch: true }))).toEqual({ chatAsksDir: undefined });
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  test("AC-4: returns only chatAsksDir without exiting", () => {
    const result = parseRunPreconditionFlags(options());
    expect(Object.keys(result)).toEqual(["chatAsksDir"]);
    expect(result.chatAsksDir).toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  test("preserves chat-asks parsing", () => {
    expect(parseRunPreconditionFlags(options({ chatAsks: "/tmp/asks" }))).toEqual({ chatAsksDir: "/tmp/asks" });
    expect(() => parseRunPreconditionFlags(options({ chatAsks: "" }))).toThrow(exitError);
    expect(stderr).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("applyRunCliOverrides", () => {
  test("preserves agent and max-cost overrides", () => {
    const defaultsBefore = structuredClone(makeNaxConfig());
    // CLI overrides mutate nested objects; the factory shares untouched default branches.
    const config = structuredClone(makeNaxConfig());
    const result = applyRunCliOverrides(config, options({ agent: "codex", maxCost: "12.5" }));
    expect(result.agent?.default).toBe("codex");
    expect(result.execution.costLimit).toBe(12.5);
    expect(makeNaxConfig()).toEqual(defaultsBefore);
  });
});
