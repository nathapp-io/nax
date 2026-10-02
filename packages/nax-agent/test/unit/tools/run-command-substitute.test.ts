import { describe, expect, test } from "bun:test";
import { substituteCommand } from "#src/tools/run-command";

describe("substituteCommand", () => {
  test("substitutes a declared placeholder", () => {
    expect(substituteCommand("bun test {{files}}", { files: "a.test.ts" })).toBe("bun test 'a.test.ts'");
  });

  test("quotes the substituted value so a metacharacter cannot escape", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a.ts; rm -rf /" });
    expect(out).toBe("bun test 'a.ts; rm -rf /'");
  });

  test("quotes an embedded single quote rather than closing the string", () => {
    const out = substituteCommand("bun test {{files}}", { files: "a'; id; '.ts" });
    expect(out).toBe(`bun test 'a'\\''; id; '\\''.ts'`);
  });

  // nax#1998: `scoped-selection.ts` quotes each file THEN joins, so the harness
  // can scope a run to several files. This function quoted the whole value as
  // one argument, so an agent could not -- 52 of 52 space-separated `files`
  // calls across 8 audited features errored. The two paths must agree.
  test("quotes each element of an array value separately", () => {
    expect(substituteCommand("bun test {{files}}", { files: ["a.test.ts", "b.test.ts"] })).toBe(
      "bun test 'a.test.ts' 'b.test.ts'",
    );
  });

  test("quotes each array element, so a metacharacter in one cannot escape", () => {
    expect(substituteCommand("bun test {{files}}", { files: ["a.ts", "b.ts; id"] })).toBe("bun test 'a.ts' 'b.ts; id'");
  });

  // An array carries its own element boundaries, so a path containing a space
  // survives. A pre-joined string could not: the join would be re-split and
  // any repo checked out under `/tmp/my dir/` would break.
  test("an array element containing a space stays one argument", () => {
    expect(substituteCommand("bun test {{files}}", { files: ["my dir/a.test.ts"] })).toBe(
      "bun test 'my dir/a.test.ts'",
    );
  });

  test("a single-element array is quoted exactly as a plain string is", () => {
    expect(substituteCommand("bun test {{files}}", { files: ["a.test.ts"] })).toBe("bun test 'a.test.ts'");
  });

  test("a string value keeps whole-value quoting, since it may be one filter with a space", () => {
    expect(substituteCommand("bun test --grep {{grep}}", { grep: "two words" })).toBe("bun test --grep 'two words'");
  });

  test("an empty array substitutes nothing rather than an empty argument", () => {
    expect(substituteCommand("bun test {{files}}", { files: [] })).toBe("bun test ");
  });

  test("preserves an env-assignment prefix, which is why this is a shell string", () => {
    expect(substituteCommand("CI=1 bun test {{files}}", { files: "a.ts" })).toBe("CI=1 bun test 'a.ts'");
  });

  test("refuses a placeholder the template does not declare, naming the declared set", () => {
    expect(substituteCommand("bun test {{files}}", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command (declared: files)',
    });
  });

  test("refuses when a declared placeholder is left unfilled, naming the declared set", () => {
    expect(substituteCommand("bun test {{files}}", {})).toEqual({
      error: "placeholder {{files}} has no value (declared: files)",
    });
  });

  test("names all declared placeholders, not just the offending one", () => {
    expect(substituteCommand("bun test {{files}} {{grep}}", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command (declared: files, grep)',
    });
  });

  test("a command with no placeholders reads naturally rather than printing an empty list", () => {
    expect(substituteCommand("bun test", { nope: "x" })).toEqual({
      error: 'value "nope" is not a placeholder in this command (this command declares no placeholders)',
    });
  });

  test("refuses a placeholder inside double quotes, where single-quote escaping is unsafe", () => {
    expect(substituteCommand('printf "%s\\n" "{{files}}"', { files: "$(printf PWNED)" })).toEqual({
      error: "placeholder {{files}} may not appear inside shell quotes",
    });
  });

  test("refuses a placeholder inside command substitution", () => {
    expect(substituteCommand("printf '%s\\n' $({{files}})", { files: "printf PWNED" })).toEqual({
      error: "placeholder {{files}} may not appear in a shell expansion",
    });
  });
});
