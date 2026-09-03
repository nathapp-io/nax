import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    const argv = buildGrepArgv("rg", "needle", undefined);
    expect(argv[0]).toBe("rg");
    expect(argv).toContain("--fixed-strings");
    expect(argv).toContain("--line-number");
    expect(argv).toContain("needle");
  });

  test("grep fallback uses recursive line-numbered fixed-string flags", () => {
    const argv = buildGrepArgv("grep", "needle", undefined);
    expect(argv.slice(0, 2)).toEqual(["grep", "-r"]);
    expect(argv).toContain("-n");
    expect(argv).toContain("-F");
  });

  test("the pattern is passed after a '--' terminator so it is never read as a flag", () => {
    const argv = buildGrepArgv("rg", "--oh-no", undefined);
    expect(argv.indexOf("--")).toBeGreaterThan(-1);
    expect(argv.indexOf("--oh-no")).toBeGreaterThan(argv.indexOf("--"));
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
});
