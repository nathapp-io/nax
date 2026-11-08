import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config/defaults";

/**
 * `makeNaxConfig` must hand back a config that owns every nested section.
 *
 * `deepMerge` produces a new top-level object but reuses the base object for any
 * section the caller does not override. Before this contract was pinned, a test
 * that deleted a key off its own config (`Reflect.deleteProperty(cfg.execution,
 * "mode")`, the "mode absent" case in `iteration-runner.test.ts`) deleted it off
 * `DEFAULT_CONFIG` for the rest of the process, and every later test file that
 * asserted on the default failed on a value no test had written: the CI
 * "Coverage floor" run failed `defaults.test.ts` and
 * `workflow-mode-normalise.test.ts` this way.
 */
describe("makeNaxConfig — the result owns its nested sections", () => {
  test("a returned config's execution section is not DEFAULT_CONFIG's execution object", () => {
    expect(makeNaxConfig().execution).not.toBe(DEFAULT_CONFIG.execution);
  });

  test("deleting a key off a returned config's execution section leaves DEFAULT_CONFIG intact", () => {
    const config = makeNaxConfig();
    const modeBefore = DEFAULT_CONFIG.execution.mode;

    Reflect.deleteProperty(config.execution, "mode");

    expect(config.execution.mode).toBeUndefined();
    expect(DEFAULT_CONFIG.execution.mode).toBe(modeBefore);
  });

  test("mutating a returned config's nested section leaves DEFAULT_CONFIG intact", () => {
    const config = makeNaxConfig();
    const defaultsBefore = structuredClone(DEFAULT_CONFIG);

    config.execution.sessionTimeoutSeconds = 1;

    expect(DEFAULT_CONFIG).toEqual(defaultsBefore);
  });

  test("overrides still merge onto the defaults", () => {
    const config = makeNaxConfig({ execution: { mode: "pipeline" } });

    expect(config.execution.mode).toBe("pipeline");
    expect(config.execution.sessionTimeoutSeconds).toBe(DEFAULT_CONFIG.execution.sessionTimeoutSeconds);
  });
});
