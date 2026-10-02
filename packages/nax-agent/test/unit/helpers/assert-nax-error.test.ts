import { describe, expect, test } from "bun:test";
import { NaxError } from "#src/infra/index";
import { assertCaughtInstanceOf, assertNaxError } from "#test/helpers/index";

describe("assertNaxError (nax-agent)", () => {
  test("narrows nax-agent's NaxError so typed members are readable without a cast", () => {
    const caught: unknown = new NaxError("boom", "SOME_CODE");
    assertNaxError(caught);
    expect(caught.code).toBe("SOME_CODE");
  });

  test("throws on a plain Error, naming what was actually caught", () => {
    expect(() => assertNaxError(new Error("plain"))).toThrow(
      'Expected caught error to be a NaxError, got Error("plain")',
    );
  });

  test("assertCaughtInstanceOf is the shared test-kit assertion", () => {
    expect(() => assertCaughtInstanceOf("nope", Error, "x")).toThrow('Expected x to be a Error, got "nope"');
  });
});
