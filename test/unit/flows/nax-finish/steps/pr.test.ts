import { afterEach, describe, expect, test } from "bun:test";
import { _prDeps, openOrPromotePr } from "@flows/nax-finish/steps/pr";
import type { RunResult } from "@flows/nax-finish/types";

const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const originalRun = _prDeps.run;
afterEach(() => {
  _prDeps.run = originalRun;
});

describe("openOrPromotePr", () => {
  test("promotes an existing draft to ready", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r.git", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 0, stdout: JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }), stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("promoted");
    expect(r.url).toBe("https://gh/pr/1");
    expect(calls.some((c) => c.includes("ready"))).toBe(true);
  });

  test("opens a new ready PR when none exists", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return ok("Creating pull request\nhttps://gh/pr/2\n");
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("opened");
    expect(r.url).toBe("https://gh/pr/2");
    expect(calls.some((c) => c.includes("create") && c.includes("--draft"))).toBe(false);
  });

  test("returns already-ready when view succeeds and not draft", async () => {
    const calls: string[][] = [];
    _prDeps.run = async (cmd) => {
      calls.push(cmd);
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: false, url: "https://gh/pr/3" }));
      return ok("");
    };
    const r = await openOrPromotePr("/repo", "feat/x", "t", "b");
    expect(r.status).toBe("already-ready");
    expect(r.url).toBe("https://gh/pr/3");
    expect(calls.some((c) => c.includes("ready"))).toBe(false);
    expect(calls.some((c) => c.includes("create"))).toBe(false);
  });

  test("throws when the remote URL doesn't match github.com or gitlab.com", async () => {
    _prDeps.run = async () => ok("git@bitbucket.org:o/r.git");
    await expect(openOrPromotePr("/repo", "feat/x", "t", "b")).rejects.toThrow();
  });

  test("throws when creating the PR fails", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pr found" };
      if (cmd.includes("create")) return { exitCode: 1, stdout: "", stderr: "auth required" };
      return ok("");
    };
    await expect(openOrPromotePr("/repo", "feat/x", "t", "b")).rejects.toThrow(/auth required/);
  });

  test("throws when promoting the draft fails", async () => {
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return ok("git@github.com:o/r.git");
      if (cmd.includes("view")) return ok(JSON.stringify({ isDraft: true, url: "https://gh/pr/1" }));
      if (cmd.includes("ready")) return { exitCode: 1, stdout: "", stderr: "conflict" };
      return ok("");
    };
    await expect(openOrPromotePr("/repo", "feat/x", "t", "b")).rejects.toThrow(/conflict/);
  });
});
