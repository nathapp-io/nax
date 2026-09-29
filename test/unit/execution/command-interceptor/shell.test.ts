/**
 * US-001 — the validated shell interception seam.
 *
 * Unlike the argv site, this one carries a string that nax hands to `/bin/sh`,
 * and it comes back out of a provider subprocess. The validator is therefore a
 * trust boundary, not a convenience: every case below is either the single shape
 * that is allowed (`rtk ` inserted at a command word, byte-for-byte) or a
 * near-miss that must run unrewritten.
 */
import { describe, expect, test } from "bun:test";
import type { CommandInterceptor, ShellInterceptRequest, ShellInterceptResult } from "@/execution/command-interceptor";
import { interceptShell, validateShellRewrite } from "@/execution/command-interceptor";

const ROOT = "/repo";

const shellReq = (command: string): ShellInterceptRequest => ({ kind: "shell", command, cwd: ROOT, site: "bash" });

/** What a provider answers with: the candidate command plus its own name. */
const candidate = (command: string): ShellInterceptResult => ({ kind: "rewritten", command, provider: "rtk" });

/** Asserts the decline and narrows it, so a test can read the reason. */
function expectDeclined(result: ShellInterceptResult): Extract<ShellInterceptResult, { kind: "declined" }> {
  expect(result.kind).toBe("declined");
  if (result.kind !== "declined") throw new Error(`expected a declined result, got ${result.kind}`);
  return result;
}

/** An interceptor with a scripted shell answer; `seen` records every request. */
function fakeShell(
  answer: ShellInterceptResult | (() => never),
  seen: ShellInterceptRequest[] = [],
): CommandInterceptor {
  return {
    provider: "rtk",
    intercept: async () => ({ kind: "unchanged" }),
    interceptShell: async (req: ShellInterceptRequest) => {
      seen.push(req);
      return typeof answer === "function" ? answer() : answer;
    },
  };
}

describe("validateShellRewrite", () => {
  test("US-001 AC1: accepts a candidate that inserts `rtk ` at the command word", () => {
    expect(validateShellRewrite(shellReq("bun test a.test.ts"), candidate("rtk bun test a.test.ts"))).toEqual({
      kind: "rewritten",
      command: "rtk bun test a.test.ts",
      provider: "rtk",
    });
  });

  test("US-001 AC2: accepts an insertion that follows a leading assignment token", () => {
    expect(validateShellRewrite(shellReq("FOO=1 bun test"), candidate("FOO=1 rtk bun test"))).toEqual({
      kind: "rewritten",
      command: "FOO=1 rtk bun test",
      provider: "rtk",
    });
  });

  test("US-001 AC3: accepts an insertion in each of two `;`-separated segments", () => {
    expect(validateShellRewrite(shellReq("bun test; git status"), candidate("rtk bun test; rtk git status"))).toEqual({
      kind: "rewritten",
      command: "rtk bun test; rtk git status",
      provider: "rtk",
    });
  });

  test("US-001 AC4: accepts a rewrite of the second `&&`-separated segment only", () => {
    expect(validateShellRewrite(shellReq("cd pkg && bun test"), candidate("cd pkg && rtk bun test"))).toEqual({
      kind: "rewritten",
      command: "cd pkg && rtk bun test",
      provider: "rtk",
    });
  });

  test("US-001 AC4 (boundary): accepts an insertion in both `&&`-separated segments", () => {
    expect(
      validateShellRewrite(shellReq("bun test && git status"), candidate("rtk bun test && rtk git status")),
    ).toEqual({ kind: "rewritten", command: "rtk bun test && rtk git status", provider: "rtk" });
  });

  test("US-001 AC4 (boundary): accepts a single insertion when the other segment is left alone", () => {
    expect(validateShellRewrite(shellReq("bun test; bun test"), candidate("rtk bun test; bun test")).kind).toBe(
      "rewritten",
    );
  });

  test("US-001 AC5: declines a candidate that changes the command word", () => {
    const out = expectDeclined(validateShellRewrite(shellReq("cat src/a.ts"), candidate("rtk read src/a.ts")));
    expect(out.reason.trim().length).toBeGreaterThan(0);
  });

  test("US-001 AC6: declines a candidate that re-spaces `&&`", () => {
    expect(validateShellRewrite(shellReq("cd pkg&&bun test"), candidate("cd pkg && rtk bun test")).kind).toBe(
      "declined",
    );
  });

  test("US-001 AC7: declines an insertion that is not at the command word", () => {
    expect(validateShellRewrite(shellReq("uv run pytest -q"), candidate("uv run rtk pytest -q")).kind).toBe("declined");
  });

  test("US-001 AC8: declines an insertion into a segment that feeds a pipe", () => {
    const out = expectDeclined(
      validateShellRewrite(shellReq("git log --oneline | head -5"), candidate("rtk git log --oneline | head -5")),
    );
    expect(out.reason.trim().length).toBeGreaterThan(0);
  });

  test("US-001 AC9: declines a candidate that re-quotes an argument", () => {
    expect(validateShellRewrite(shellReq("bun test 'a b.ts'"), candidate('rtk bun test "a b.ts"')).kind).toBe(
      "declined",
    );
  });

  test("US-001 AC10: declines a second insertion into a segment already prefixed with rtk", () => {
    expect(validateShellRewrite(shellReq("rtk bun test"), candidate("rtk rtk bun test")).kind).toBe("declined");
  });

  test("US-001 AC11: declines a candidate that appends a segment", () => {
    expect(validateShellRewrite(shellReq("bun test"), candidate("rtk bun test; rm -rf .")).kind).toBe("declined");
  });

  test("US-001 AC12: declines an insertion into a segment that reads a pipe", () => {
    expect(validateShellRewrite(shellReq("cat x | grep y"), candidate("cat x | rtk grep y")).kind).toBe("declined");
  });

  test("US-001 AC13: declines when the original does not lex", () => {
    const out = expectDeclined(validateShellRewrite(shellReq("bun test $(id)"), candidate("rtk bun test $(id)")));
    expect(out.reason.trim().length).toBeGreaterThan(0);
  });

  test("US-001 AC14: returns unchanged when the candidate equals the original", () => {
    expect(validateShellRewrite(shellReq("bun test"), candidate("bun test"))).toEqual({ kind: "unchanged" });
  });

  test("US-001 AC15: returns an unchanged result it was given, unmodified", () => {
    expect(validateShellRewrite(shellReq("bun test"), { kind: "unchanged" })).toEqual({ kind: "unchanged" });
  });

  test("US-001 AC15: returns a declined result it was given, reason intact", () => {
    const declined: ShellInterceptResult = { kind: "declined", reason: "rtk rewrite exited 2" };
    expect(validateShellRewrite(shellReq("bun test"), declined)).toEqual(declined);
  });

  test("US-001 AC13 (boundary): declines an empty original", () => {
    expect(validateShellRewrite(shellReq(""), candidate("rtk ")).kind).toBe("declined");
  });

  test("US-001 AC13 (boundary): declines an original that is only whitespace", () => {
    const blank = "   ";
    expect(validateShellRewrite(shellReq(blank), candidate(`rtk ${blank}`)).kind).toBe("declined");
  });

  test("US-001 AC1 (boundary): declines an insertion that splits a word", () => {
    // `brtk bun test` holds `rtk ` too, but removing it leaves `bun test`…
    // which is NOT what the byte-walk sees from `bun test`.
    expect(validateShellRewrite(shellReq("bun test"), candidate("brtk bun test")).kind).toBe("declined");
  });

  test("US-001 AC1 (boundary): declines a candidate that adds a trailing space", () => {
    expect(validateShellRewrite(shellReq("bun test"), candidate("rtk bun test ")).kind).toBe("declined");
  });
});

describe("interceptShell", () => {
  test("US-001 AC16: runs the original when there is no interceptor", async () => {
    expect(await interceptShell("bun test", ROOT, undefined)).toEqual({ command: "bun test", rewritten: false });
  });

  test("US-001 AC16 (boundary): runs an empty command as-is when there is no interceptor", async () => {
    expect(await interceptShell("", ROOT, undefined)).toEqual({ command: "", rewritten: false });
  });

  test("US-001 AC17: runs the original when the interceptor has no interceptShell method", async () => {
    const argvOnly: CommandInterceptor = {
      provider: "rtk",
      intercept: async () => ({ kind: "unchanged" }),
    };
    expect(await interceptShell("bun test", ROOT, argvOnly)).toEqual({ command: "bun test", rewritten: false });
  });

  test("US-001 AC18: asks the interceptor once with the shell request", async () => {
    const seen: ShellInterceptRequest[] = [];
    await interceptShell("bun test", ROOT, fakeShell({ kind: "unchanged" }, seen));
    expect(seen).toEqual([{ kind: "shell", command: "bun test", cwd: ROOT, site: "bash" }]);
  });

  test("US-001 AC19: returns the validated rewrite", async () => {
    const out = await interceptShell("bun test", ROOT, fakeShell(candidate("rtk bun test")));
    expect(out).toEqual({ command: "rtk bun test", provider: "rtk", rewritten: true });
  });

  test("US-001 AC20: runs the original when the candidate fails validation", async () => {
    const out = await interceptShell("cat src/a.ts", ROOT, fakeShell(candidate("rtk read src/a.ts")));
    expect(out).toEqual({ command: "cat src/a.ts", rewritten: false });
  });

  test("US-001 AC21: runs the original when the interceptor throws", async () => {
    const boom = (): never => {
      throw new Error("rtk rewrite failed: spawn ENOENT");
    };
    expect(await interceptShell("bun test", ROOT, fakeShell(boom))).toEqual({
      command: "bun test",
      rewritten: false,
    });
  });

  test("US-001 AC16 (boundary): runs the original when the interceptor answers unchanged", async () => {
    expect(await interceptShell("bun test", ROOT, fakeShell({ kind: "unchanged" }))).toEqual({
      command: "bun test",
      rewritten: false,
    });
  });

  test("US-001 AC16 (boundary): runs the original when the interceptor answers declined", async () => {
    const answer: ShellInterceptResult = { kind: "declined", reason: "rtk rewrite exited 127" };
    expect(await interceptShell("bun test", ROOT, fakeShell(answer))).toEqual({
      command: "bun test",
      rewritten: false,
    });
  });

  test("US-001 AC14 (boundary): runs the original when the candidate equals it", async () => {
    expect(await interceptShell("bun test", ROOT, fakeShell(candidate("bun test")))).toEqual({
      command: "bun test",
      rewritten: false,
    });
  });
});

describe("the command-interceptor barrel", () => {
  test("US-001 AC22: exposes the shell seam's two functions", () => {
    expect(typeof validateShellRewrite).toBe("function");
    expect(typeof interceptShell).toBe("function");
  });
});
