import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import { NaxError } from "@/errors";

describe("assertNaxError", () => {
  test("narrows a NaxError so typed members are readable without a cast", () => {
    const caught: unknown = new NaxError("boom", "SOME_CODE", { key: "value" });
    assertNaxError(caught);
    expect(caught.code).toBe("SOME_CODE");
    expect(caught.context?.key).toBe("value");
  });

  test("accepts NaxError subclasses (they satisfy instanceof)", () => {
    class SpecialError extends NaxError {}
    const caught: unknown = new SpecialError("sub", "SUB_CODE");
    assertNaxError(caught);
    expect(caught.code).toBe("SUB_CODE");
  });

  test("throws on a plain Error, naming what was actually caught", () => {
    const caught: unknown = new Error("plain");
    expect(() => assertNaxError(caught)).toThrow('Expected caught error to be a NaxError, got Error("plain")');
  });

  test.each([
    ["a string", "not an error"],
    ["null", null],
    ["undefined", undefined],
    ["a plain object", { code: "FAKE" }],
  ])("throws when the value is %s, describing it instead of dying at the assertion site", (_name, value) => {
    expect(() => assertNaxError(value, "caught error")).toThrow("Expected caught error to be a NaxError");
  });
});
