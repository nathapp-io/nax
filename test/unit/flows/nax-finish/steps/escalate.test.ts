import { afterEach, describe, expect, test } from "bun:test";
import { _escalateDeps, buildEscalationComment, postEscalation } from "@flows/nax-finish/steps/escalate";
import type { RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const originalRun = _escalateDeps.run;
afterEach(() => {
  _escalateDeps.run = originalRun;
});

describe("buildEscalationComment", () => {
  test("names the reason and lists findings", () => {
    const c = buildEscalationComment("my-feat", "AC-3 contradicts the response shape", [
      {
        severity: "HIGH",
        title: "wrong status code",
        problem: "returns 200 not 201",
        fix: "note intentional deviation",
      },
    ]);
    expect(c).toContain("nax-finish escalation");
    expect(c).toContain("AC-3 contradicts the response shape");
    expect(c).toContain("[HIGH] wrong status code");
  });
});

describe("postEscalation", () => {
  test("comments on an existing PR when one exists (github)", async () => {
    const calls: string[][] = [];
    _escalateDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ url: "https://github.com/o/r/pull/1" }));
      return ok("");
    };
    const r = await postEscalation("/repo", "feat/x", "some comment");
    expect(r.url).toBe("https://github.com/o/r/pull/1");
    expect(calls.some((c) => c.join(" ").includes("pr comment"))).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("pr create"))).toBe(false);
  });

  test("opens a draft to hold it when no PR exists (github)", async () => {
    const calls: string[][] = [];
    _escalateDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return ok("Opening a pull request\nhttps://github.com/o/r/pull/2\n");
      return ok("");
    };
    const r = await postEscalation("/repo", "feat/x", "some comment");
    expect(r.url).toBe("https://github.com/o/r/pull/2");
    expect(calls.some((c) => c.join(" ").includes("pr create") && c.includes("--draft"))).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("pr comment"))).toBe(false);
  });

  test("prefers Telegram: no comment, and no draft PR opened to hold one", async () => {
    const calls: string[][] = [];
    _escalateDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      return ok("");
    };
    const r = await postEscalation("/repo", "feat/x", "comment", { preferTelegram: true });
    expect(r.channel).toBe("telegram");
    expect(r.url).toBeUndefined();
    expect(calls.some((c) => c.join(" ").includes("pr create"))).toBe(false);
    expect(calls.some((c) => c.join(" ").includes("pr comment"))).toBe(false);
  });

  test("prefers Telegram but still reports an existing PR URL for the notification", async () => {
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ url: "https://github.com/o/r/pull/7" }));
      return ok("");
    };
    const r = await postEscalation("/repo", "feat/x", "comment", { preferTelegram: true });
    expect(r).toEqual({ channel: "telegram", url: "https://github.com/o/r/pull/7" });
  });

  test("falls back to the PR comment channel when Telegram is not preferred", async () => {
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ url: "https://github.com/o/r/pull/1" }));
      return ok("");
    };
    const r = await postEscalation("/repo", "feat/x", "comment", { preferTelegram: false });
    expect(r.channel).toBe("pr-comment");
  });

  test("throws when the remote is neither github nor gitlab", async () => {
    _escalateDeps.run = async () => ok("git@bitbucket.org:o/r.git");
    await expect(postEscalation("/repo", "feat/x", "comment")).rejects.toThrow();
  });

  test("throws when posting the comment fails", async () => {
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ url: "https://github.com/o/r/pull/1" }));
      if (cmd.includes("comment")) return { exitCode: 1, stdout: "", stderr: "not authorized" };
      return ok("");
    };
    await expect(postEscalation("/repo", "feat/x", "comment")).rejects.toThrow(/not authorized/);
  });

  test("throws when opening the draft fails", async () => {
    _escalateDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return { exitCode: 1, stdout: "", stderr: "rate limited" };
      return ok("");
    };
    await expect(postEscalation("/repo", "feat/x", "comment")).rejects.toThrow(/rate limited/);
  });
});
