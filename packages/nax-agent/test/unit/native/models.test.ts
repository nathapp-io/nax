import { describe, expect, test } from "bun:test";
import { getSafeLogger, setAgentLogger } from "#src/infra/index";
import type { NaxError } from "#src/infra/index";
import { parseNativeModel, resolveContextWindow, toThinkingLevel } from "#src/native/models";
import { assertNaxError, makeLogger } from "#test/helpers/index";

const originalLogger = getSafeLogger();

/** Run a function that must throw a NaxError, and return it asserted. */
function expectNaxError(run: () => unknown, label: string): NaxError {
  try {
    run();
  } catch (err) {
    assertNaxError(err, label);
    return err;
  }
  throw new Error(`${label}: expected a NaxError`);
}

describe("parseNativeModel", () => {
  test.each(["gpt-5", "openrouter/", "/deepseek", "claude-opus-5[high]"])(
    "rejects %s as malformed with NATIVE_MODEL_MALFORMED",
    (raw) => {
      const err = expectNaxError(() => parseNativeModel(raw), `parseNativeModel(${raw})`);
      expect(err.code).toBe("NATIVE_MODEL_MALFORMED");
    },
  );
});

describe("toThinkingLevel", () => {
  test("passes a valid level through", () => {
    expect(toThinkingLevel("high")).toBe("high");
  });

  test("an unknown effort warns once with the effort in data and returns undefined", () => {
    const logger = makeLogger();
    setAgentLogger(logger);
    try {
      expect(toThinkingLevel("turbo")).toBeUndefined();
      const warns = logger.calls.filter((call) => call.level === "warn");
      expect(warns).toHaveLength(1);
      expect(warns[0].data).toMatchObject({ effort: "turbo" });
    } finally {
      setAgentLogger(originalLogger);
    }
    expect(toThinkingLevel(undefined)).toBeUndefined();
  });
});

describe("resolveContextWindow", () => {
  test("an override above the real window throws CONTEXT_WINDOW_OVERRIDE_EXCEEDS_REAL_WINDOW", () => {
    const err = expectNaxError(() => resolveContextWindow(200_000, 128_000), "window override rejection");
    expect(err.code).toBe("CONTEXT_WINDOW_OVERRIDE_EXCEEDS_REAL_WINDOW");
  });

  test("an override at or below the real window is accepted, and undefined falls back", () => {
    expect(resolveContextWindow(128_000, 128_000)).toBe(128_000);
    expect(resolveContextWindow(8_000, 128_000)).toBe(8_000);
    expect(resolveContextWindow(undefined, 128_000)).toBe(128_000);
  });
});
