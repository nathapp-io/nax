import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _grepDeps, buildGrepArgv, DEFAULT_TOOL_MAX_FILE_BYTES, grepTool } from "@/tools";

let root: string;
const realWhich = _grepDeps.which;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nax-grep-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const needle = 1;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const other = 2;\n");
});

afterEach(() => {
  _grepDeps.which = realWhich;
});

function ctx(resolvedPaths: readonly string[] = [], maxBytes = 10_000) {
  return { root, resolvedPaths, maxBytes, maxFileBytes: DEFAULT_TOOL_MAX_FILE_BYTES };
}

describe("buildGrepArgv", () => {
  test("ripgrep form is fixed-string, line-numbered, and never a shell string", () => {
    const argv = buildGrepArgv("rg", "needle", undefined, "literal");
    expect(argv[0]).toBe("rg");
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--line-number");
    expect(argv).toContain("needle");
  });

  test("grep fallback uses recursive line-numbered fixed-string flags", () => {
    const argv = buildGrepArgv("grep", "needle", undefined, "literal");
    expect(argv.slice(0, 2)).toEqual(["grep", "-r"]);
    expect(argv).toContain("-n");
    expect(argv).toContain("-F");
  });

  test("the pattern is passed after a '--' terminator so it is never read as a flag", () => {
    const argv = buildGrepArgv("rg", "--oh-no", undefined, "literal");
    expect(argv.indexOf("--")).toBeGreaterThan(-1);
    expect(argv.indexOf("--oh-no")).toBeGreaterThan(argv.indexOf("--"));
  });

  test("ripgrep regex mode drops --fixed-strings but keeps the '--' terminator", () => {
    const argv = buildGrepArgv("rg", "fo+|bar", undefined, "regex");
    expect(argv[0]).toBe("rg");
    expect(argv).not.toContain("--fixed-strings");
    expect(argv).toContain("--line-number");
    expect(argv.indexOf("--")).toBeGreaterThan(-1);
    expect(argv.indexOf("fo+|bar")).toBeGreaterThan(argv.indexOf("--"));
  });

  test("grep fallback regex mode uses -E (ERE), not -F", () => {
    const argv = buildGrepArgv("grep", "fo+|bar", undefined, "regex");
    expect(argv.slice(0, 2)).toEqual(["grep", "-r"]);
    expect(argv).toContain("-n");
    expect(argv).toContain("-E");
    expect(argv).not.toContain("-F");
    expect(argv.indexOf("--")).toBeGreaterThan(-1);
  });

  test("defaults to literal mode when no mode argument is passed", () => {
    const argv = buildGrepArgv("rg", "needle", undefined);
    expect(argv).toContain("--fixed-strings");
  });
});

describe("grepTool", () => {
  test("finds a match using whichever binary is present", async () => {
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.content).toContain("a.ts");
    expect(res.content).not.toContain("b.ts");
  });

  test("produces the same match via the grep fallback when rg is absent", async () => {
    _grepDeps.which = (name: string) => (name === "rg" ? null : realWhich(name));
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.content).toContain("a.ts");
  });

  test("no match is an empty result, not an error", async () => {
    const res = await grepTool.run({ pattern: "zzz-nothing-zzz" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches");
  });

  test("errors when neither binary is available", async () => {
    _grepDeps.which = () => null;
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/ripgrep|grep/i);
  });

  test("searches the policy-resolved target, not the raw path input", async () => {
    const resolved = join(root, "src", "a.ts");
    const res = await grepTool.run({ pattern: "needle", path: "src/a.ts" }, ctx([resolved]));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("needle");
  });

  test("declares the path field, so it is gated through the policy containment seam", () => {
    expect(grepTool.scope.pathFields).toEqual(["path"]);
  });

  test("AC1: zero-match with regex metacharacter pattern discloses literal search", async () => {
    // Pattern "export.*divide" contains metacharacters (. *), no literal occurrence exists
    const res = await grepTool.run({ pattern: "export.*divide" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches for");
    expect(res.content).toContain("export.*divide");
    expect(res.content).toContain("literally");
    expect(res.content).toContain("regex metacharacters");
    expect(res.content).toContain("not interpreted");
  });

  test("AC2: zero-match without regex metacharacters does not mention metacharacters", async () => {
    const res = await grepTool.run({ pattern: "zzz-nothing-zzz" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches for");
    expect(res.content).toContain("zzz-nothing-zzz");
    expect(res.content).not.toContain("regex metacharacters");
    expect(res.content).not.toContain("not interpreted");
  });

  test("AC3: zero-match with metacharacters has no isError set", async () => {
    const res = await grepTool.run({ pattern: "export.*divide" }, ctx());
    expect(res.isError).toBeFalsy();
  });

  test("AC4 (revised by #1922): a literal MATCH with regex metacharacters now discloses too", async () => {
    // Create a file with content that matches literally (not as regex). Before
    // #1922 this silently returned a partial result with no cue that "export.*divide"
    // was never interpreted as a pattern -- the worse case #1868 described, because
    // the caller has positive evidence and no signal anything was lost.
    const cPath = join(root, "src", "c.ts");
    writeFileSync(cPath, "export.*divide literally in the file\n");
    try {
      const res = await grepTool.run({ pattern: "export.*divide" }, ctx());
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("c.ts");
      expect(res.content).toContain("literally");
      expect(res.content).toContain("regex metacharacters");
      expect(res.content).toContain("not interpreted");
    } finally {
      unlinkSync(cPath);
    }
  });

  test("AC5: error when neither binary is available is unchanged", async () => {
    _grepDeps.which = () => null;
    const res = await grepTool.run({ pattern: "needle" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/ripgrep|grep/i);
  });

  test("pattern_type defaults to literal: a metacharacter pattern does not match as a regex", async () => {
    // "need.e" would match "needle" as a regex (any char for '.') but there is
    // no literal occurrence of the string "need.e" in the fixtures.
    const res = await grepTool.run({ pattern: "need.e" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("no matches for");
  });

  test("pattern_type: regex interprets alternation", async () => {
    const res = await grepTool.run({ pattern: "needle|other", pattern_type: "regex" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("a.ts");
    expect(res.content).toContain("b.ts");
  });

  test("pattern_type: regex interprets a character class in the dialect both binaries share", async () => {
    // [0-9] is POSIX ERE and Rust-regex alike, so this pins regex mode itself
    // rather than whichever binary the machine happens to have.
    const dPath = join(root, "src", "d.ts");
    writeFileSync(dPath, "export const version = 42;\n");
    try {
      const res = await grepTool.run({ pattern: "version = [0-9]+", pattern_type: "regex" }, ctx());
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("d.ts");
    } finally {
      unlinkSync(dPath);
    }
  });

  test.if(realWhich("rg") !== null)("pattern_type: regex interprets \\d-style escapes under ripgrep", async () => {
    const dPath = join(root, "src", "d.ts");
    writeFileSync(dPath, "export const version = 42;\n");
    try {
      const res = await grepTool.run({ pattern: "version = \\d+", pattern_type: "regex" }, ctx());
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("d.ts");
    } finally {
      unlinkSync(dPath);
    }
  });

  test("regex mode through the grep fallback discloses the POSIX ERE dialect", async () => {
    // GNU grep reads `\d` as a literal `d` while the BSD grep on macOS matches a
    // digit, so the same pattern can return a different answer per platform.
    // The result must say so rather than let that divergence pass silently.
    _grepDeps.which = (name: string) => (name === "rg" ? null : realWhich(name));
    const res = await grepTool.run({ pattern: "needle|other", pattern_type: "regex" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("a.ts");
    expect(res.content).toContain("POSIX ERE");
    expect(res.content).toContain("ripgrep is not installed");
  });

  test.if(realWhich("rg") !== null)("regex mode under ripgrep carries no dialect note", async () => {
    const res = await grepTool.run({ pattern: "needle|other", pattern_type: "regex" }, ctx());
    expect(res.content).not.toContain("POSIX ERE");
  });

  test("pattern_type: regex never discloses a literal-search caveat, even with metacharacters", async () => {
    const res = await grepTool.run({ pattern: "export.*divide", pattern_type: "regex" }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain("regex metacharacters");
    expect(res.content).not.toContain("performed literally");
  });

  test("an invalid regex surfaces the binary's own stderr message as an error, not a silent empty result", async () => {
    const res = await grepTool.run({ pattern: "a(b", pattern_type: "regex" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content.length).toBeGreaterThan(0);
  });
});
