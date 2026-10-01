/**
 * dotenv.test.ts — Tests for parseDotenv() and resolveEnvVars()
 *
 * Story US-001-B: Implement parseDotenv() and resolveEnvVars() in src/config/dotenv.ts
 */

import { describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf } from "@test/helpers";
import { parseDotenv, resolveEnvVars } from "@/config/dotenv";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("parseDotenv", () => {
  test("parses standard dotenv content stripping comments, blank lines, export prefixes, and quotes", () => {
    const content = 'FOO=bar\n# comment\n\nexport BAZ=qux\nQUOTED="hello world"';
    const result = parseDotenv(content);
    expect(result).toEqual({ FOO: "bar", BAZ: "qux", QUOTED: "hello world" });
  });

  test("returns an empty object for empty input", () => {
    expect(parseDotenv("")).toEqual({});
  });

  test("strips export prefix from key", () => {
    expect(parseDotenv("export KEY=value")).toEqual({ KEY: "value" });
  });
});

describe("resolveEnvVars", () => {
  test("replaces $VAR references recursively in nested objects", () => {
    const config = { a: "$FOO", b: { c: "$BAR" } };
    const env = { FOO: "x", BAR: "y" };
    expect(resolveEnvVars(config, env)).toEqual({ a: "x", b: { c: "y" } });
  });

  test("throws an error containing the variable name and $VAR reference when env var is missing", () => {
    expect(() => resolveEnvVars({ a: "$MISSING" }, {})).toThrow();
    let caught: unknown;
    try {
      resolveEnvVars({ a: "$MISSING" }, {});
    } catch (err) {
      caught = err;
    }
    assertCaughtInstanceOf(caught, Error, "resolveEnvVars rejection");
    expect(caught.message).toContain("MISSING");
    expect(caught.message).toContain("$MISSING");
  });

  test("passes through non-string values unchanged (numbers and arrays)", () => {
    const config = { n: 5, arr: [1, 2] };
    expect(resolveEnvVars(config, {})).toEqual({ n: 5, arr: [1, 2] });
  });

  test("resolves double-dollar escape ($$VAR) to a literal dollar sign ($VAR)", () => {
    expect(resolveEnvVars({ a: "$$LITERAL" }, {})).toEqual({ a: "$LITERAL" });
  });

  test("supports inline substitution within a string (prefix-$VAR-suffix)", () => {
    expect(resolveEnvVars({ a: "prefix-$FOO-suffix" }, { FOO: "mid" })).toEqual({ a: "prefix-mid-suffix" });
  });

  test("US-003 AC3: literal text of the module's double-dollar escape placeholder followed by HOME is preserved verbatim rather than restored to $HOME", () => {
    const placeholder = "\x00__DOLLAR_ESCAPE__\x00";
    const literal = `${placeholder}HOME`;
    const result = resolveEnvVars(literal, { HOME: "/Users/example" });
    expect(result).toBe(literal);
    expect(result).not.toBe("$HOME");
    expect(result).toContain("\x00");
  });

  test("SEC-9: a __proto__ key from config does not change the result's prototype, is not copied, and leaks no inherited keys", () => {
    const config = JSON.parse('{"__proto__": {"polluted": true}, "safe": "$FOO"}');
    const result = resolveEnvVars(config, { FOO: "x" });
    if (!isRecord(result)) throw new Error("resolveEnvVars must return an object for object input");

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect("polluted" in result).toBe(false);
    expect(result.polluted).toBeUndefined();
    expect(result.safe).toBe("x");
  });

  test("SEC-9: constructor and prototype keys from config are skipped", () => {
    const config = {
      constructor: { polluted: true },
      prototype: { polluted: true },
      safe: "kept",
    };
    const result = resolveEnvVars(config, {});
    if (!isRecord(result)) throw new Error("resolveEnvVars must return an object for object input");

    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(Object.hasOwn(result, "prototype")).toBe(false);
    expect(result.safe).toBe("kept");
  });
});
