import { describe, expect, test } from "bun:test";
import { detectForge, extractUrl, viewArgv } from "@flows/nax-finish/steps/forge";
import type { RunFn, RunResult } from "@flows/nax-finish/types";

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const missing = (): RunResult => ({ exitCode: 127, stdout: "", stderr: "command not found" });

/** A `run` that answers `git remote get-url` with `remote`, and CLI probes per `cli`. */
const runner = (remote: string, cli: { gh?: boolean; glab?: boolean } = {}): RunFn => {
  return async (cmd) => {
    if (cmd.join(" ").includes("remote get-url")) return ok(remote);
    if (cmd[0] === "gh") return cli.gh ? ok("gh version 2.0.0") : missing();
    if (cmd[0] === "glab") return cli.glab ? ok("glab 1.0.0") : missing();
    return ok();
  };
};

describe("detectForge", () => {
  test.each([
    ["git@github.com:o/r.git", "github"],
    ["https://github.com/o/r.git", "github"],
    ["git@gitlab.com:g/p/r.git", "gitlab"],
    ["https://gitlab.com/g/p/r.git", "gitlab"],
  ])("recognises the hosted forge %s", async (remote, expected) => {
    expect(await detectForge(runner(remote), "/repo", "test")).toBe(expected);
  });

  // Regression: substring matching on "gitlab.com" rejected every self-hosted
  // instance — "gitlab.mycorp.com".includes("gitlab.com") is false (#1399).
  test.each([
    ["git@gitlab.mycorp.com:g/r.git", "gitlab"],
    ["https://gitlab.internal.example.org/g/r.git", "gitlab"],
    ["ssh://git@github.mycorp.com:2222/o/r.git", "github"],
  ])("recognises the self-hosted forge %s by host", async (remote, expected) => {
    expect(await detectForge(runner(remote), "/repo", "test")).toBe(expected);
  });

  test("falls back to the only installed CLI when the host names neither forge", async () => {
    expect(await detectForge(runner("git@git.mycorp.com:o/r.git", { glab: true }), "/repo", "test")).toBe("gitlab");
    expect(await detectForge(runner("git@git.mycorp.com:o/r.git", { gh: true }), "/repo", "test")).toBe("github");
  });

  test("throws when the host is unrecognised and the CLI probe is ambiguous", async () => {
    await expect(detectForge(runner("git@git.mycorp.com:o/r.git", { gh: true, glab: true }), "/repo", "s")).rejects.toThrow(
      /git\.mycorp\.com/,
    );
    await expect(detectForge(runner("git@git.mycorp.com:o/r.git"), "/repo", "s")).rejects.toThrow(/git\.mycorp\.com/);
  });

  test("throws when the repo has no origin remote at all", async () => {
    const run: RunFn = async () => ({ exitCode: 128, stdout: "", stderr: "no such remote" });
    await expect(detectForge(run, "/repo", "s")).rejects.toThrow(/FINISH_UNKNOWN_FORGE|remote/);
  });
});

describe("extractUrl", () => {
  test("prefers a JSON url field, then web_url, then a raw URL", () => {
    expect(extractUrl(JSON.stringify({ url: "https://gh/pr/1" }))).toBe("https://gh/pr/1");
    expect(extractUrl(JSON.stringify({ web_url: "https://gl/mr/2" }))).toBe("https://gl/mr/2");
    expect(extractUrl("created: https://gh/pr/3\n")).toBe("https://gh/pr/3");
  });

  test("returns undefined when there is no URL", () => {
    expect(extractUrl("nothing here")).toBeUndefined();
  });
});

describe("viewArgv", () => {
  test("asks each forge for its own JSON shape", () => {
    expect(viewArgv("github", "feat/x", "isDraft,url")).toEqual(["gh", "pr", "view", "feat/x", "--json", "isDraft,url"]);
    expect(viewArgv("gitlab", "feat/x", "isDraft,url")).toEqual(["glab", "mr", "view", "feat/x", "--output", "json"]);
  });
});
