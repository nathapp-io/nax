import { afterEach, describe, expect, test } from "bun:test";
import * as bot from "@/bot";
import { buildUntrustedRequestIssue } from "@/prompts";

const original = bot._fixInputDeps ? { ...bot._fixInputDeps } : undefined;
afterEach(() => {
  if (original) Object.assign(bot._fixInputDeps, original);
});
const thread = {
  kind: "thread",
  key: "t-1",
  issue: "Rename x",
  reason: "clearer",
  threadId: "T1",
  replyTo: "C1",
} as const;

describe("toFixFindings", () => {
  test("AC-6 maps finding identity, severity and location", () => {
    expect(
      bot.toFixFindings([
        { kind: "finding", key: "f-1", severity: "minor", issue: "Leak", file: "a.ts", suggestion: "Close it" },
      ]),
    ).toEqual([{ id: "f-1", kind: "quality", severity: "minor", issue: "Leak", file: "a.ts", suggestion: "Close it" }]);
  });
  test.each(["thread", "comment"] as const)("AC-7 fences %s requests", (kind) => {
    expect(bot.toFixFindings([{ ...thread, kind }])[0]?.issue).toBe(buildUntrustedRequestIssue("Rename x", "clearer"));
  });
  test("AC-8 defaults thread severity to important", () => {
    expect(bot.toFixFindings([thread])[0]?.severity).toBe("important");
  });
  test("AC-9 keeps thread file and line", () => {
    expect(bot.toFixFindings([{ ...thread, file: "a.ts", line: 7 }])[0]).toMatchObject({ file: "a.ts", line: 7 });
  });
});

describe("checkPushAccess", () => {
  test("AC-10 probes the exact remote ref in the worktree", async () => {
    const calls: unknown[] = [];
    bot._fixInputDeps.runGit = async (argv, cwd) => {
      calls.push([argv, cwd]);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await bot.checkPushAccess("/w", "feat/x");
    expect(calls).toEqual([[["push", "--dry-run", "origin", "HEAD:refs/heads/feat/x"], "/w"]]);
  });
  test("AC-11 returns success for exit zero", async () => {
    bot._fixInputDeps.runGit = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    expect(await bot.checkPushAccess("/w", "feat/x")).toEqual({ ok: true });
  });
  test("AC-12 returns only the first stderr line on rejection", async () => {
    bot._fixInputDeps.runGit = async () => ({ exitCode: 1, stdout: "", stderr: "remote: Permission denied\nmore" });
    expect(await bot.checkPushAccess("/w", "feat/x")).toEqual({ ok: false, reason: "remote: Permission denied" });
  });
});

test("push access timeout is diagnostic, not an empty refusal", async () => {
  bot._fixInputDeps.runGit = async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: true });
  expect(await bot.checkPushAccess("/w", "feat/x")).toEqual({ ok: false, reason: "push access probe timed out" });
});
test("a vanished artifact mtime does not hide another review", async () => {
  bot._fixInputDeps.glob = async () => ["vanished", "present"];
  bot._fixInputDeps.readText = async () => JSON.stringify({ version: 1, headSha: "h" });
  bot._fixInputDeps.mtimeMs = async (path) => {
    if (path === "vanished") throw new Error("ENOENT");
    return 1;
  };
  expect(await bot.loadLatestReview("/o", 42, "h")).toMatchObject({ headSha: "h" });
});
