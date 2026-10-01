import { describe, expect, test } from "bun:test";
// Access internal functions for testing
import { hasShellOperators, validateHookCommand } from "@/hooks/runner";

describe("Hook Shell Security (SEC-3)", () => {
  test("hasShellOperators detects backticks", () => {
    expect(hasShellOperators("echo `whoami`")).toBe(true);
  });

  test("hasShellOperators detects pipes and redirects", () => {
    expect(hasShellOperators("echo hi | grep h")).toBe(true);
    expect(hasShellOperators("echo hi > file.txt")).toBe(true);
  });

  test("validateHookCommand blocks backtick substitution", () => {
    expect(() => validateHookCommand("echo `whoami`")).toThrow(/dangerous pattern/);
  });

  test("validateHookCommand blocks $(...) substitution", () => {
    expect(() => validateHookCommand("echo $(whoami)")).toThrow(/dangerous pattern/);
  });

  test("validateHookCommand blocks eval", () => {
    expect(() => validateHookCommand("eval 'echo hi'")).toThrow(/dangerous pattern/);
  });

  test("allows safe commands", () => {
    expect(() => validateHookCommand("echo 'Hello World'")).not.toThrow();
    expect(() => validateHookCommand("bun test")).not.toThrow();
  });
});

import { parseCommandToArgv } from "@/hooks/runner";

describe("Hook tilde expansion", () => {
  test("expands ~/ to HOME in hook command tokens", () => {
    const home = process.env.HOME ?? "";
    const argv = parseCommandToArgv("bash ~/.nax/scripts/hook-log.sh");
    expect(argv).toEqual(["bash", `${home}/.nax/scripts/hook-log.sh`]);
  });

  test("does not expand ~ in the middle of a token", () => {
    const argv = parseCommandToArgv("echo foo~/bar");
    expect(argv).toEqual(["echo", "foo~/bar"]);
  });

  test("handles command with no tilde", () => {
    const argv = parseCommandToArgv("bash /usr/local/bin/script.sh");
    expect(argv).toEqual(["bash", "/usr/local/bin/script.sh"]);
  });
});
