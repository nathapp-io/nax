/**
 * dotenv.test.ts — Tests for parseDotenv() and resolveEnvVars()
 *
 * Story US-001-B: Implement parseDotenv() and resolveEnvVars() in src/config/dotenv.ts
 */

import { describe, expect, test } from "bun:test";
import { parseDotenv, resolveEnvVars } from "../../../src/config/dotenv";

describe("parseDotenv", () => {
  test("parses standard dotenv content stripping comments, blank lines, export prefixes, and quotes", () => {
    const content =
      'FOO=bar\n# comment\n\nexport BAZ=qux\nQUOTED="hello world"';
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
    try {
      resolveEnvVars({ a: "$MISSING" }, {});
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("MISSING");
      expect(msg).toContain("$MISSING");
    }
  });

  test("passes through non-string values unchanged (numbers and arrays)", () => {
    const config = { n: 5, arr: [1, 2] };
    expect(resolveEnvVars(config, {})).toEqual({ n: 5, arr: [1, 2] });
  });

  test("resolves double-dollar escape ($$VAR) to a literal dollar sign ($VAR)", () => {
    expect(resolveEnvVars({ a: "$$LITERAL" }, {})).toEqual({ a: "$LITERAL" });
  });

  test("supports inline substitution within a string (prefix-$VAR-suffix)", () => {
    expect(resolveEnvVars({ a: "prefix-$FOO-suffix" }, { FOO: "mid" })).toEqual(
      { a: "prefix-mid-suffix" },
    );
  });
});
