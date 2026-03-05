import { describe, expect, test } from "bun:test";
// Access internal functions for testing
// @ts-ignore
import { hasShellOperators, validateHookCommand } from "../../../src/hooks/runner";

describe("Hook Shell Security (SEC-3)", () => {
  test("hasShellOperators detects backticks", () => {
    // @ts-ignore
    expect(hasShellOperators("echo `whoami`")).toBe(true);
  });

  test("hasShellOperators detects pipes and redirects", () => {
    // @ts-ignore
    expect(hasShellOperators("echo hi | grep h")).toBe(true);
    // @ts-ignore
    expect(hasShellOperators("echo hi > file.txt")).toBe(true);
  });

  test("validateHookCommand blocks backtick substitution", () => {
    // @ts-ignore
    expect(() => validateHookCommand("echo `whoami`")).toThrow(/dangerous pattern/);
  });

  test("validateHookCommand blocks $(...) substitution", () => {
    // @ts-ignore
    expect(() => validateHookCommand("echo $(whoami)")).toThrow(/dangerous pattern/);
  });

  test("validateHookCommand blocks eval", () => {
    // @ts-ignore
    expect(() => validateHookCommand("eval 'echo hi'")).toThrow(/dangerous pattern/);
  });

  test("allows safe commands", () => {
    // @ts-ignore
    expect(() => validateHookCommand("echo 'Hello World'")).not.toThrow();
    // @ts-ignore
    expect(() => validateHookCommand("bun test")).not.toThrow();
  });
});
