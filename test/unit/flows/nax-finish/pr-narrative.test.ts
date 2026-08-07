/**
 * `amend_body` — rewriting the PR body once the narrative node produced prose.
 *
 * Runs after the PR is already open, so every assertion here is about NOT
 * failing: a throw would fail the flow after its real work succeeded.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { amendPrBodyNode } from "@flows/nax-finish/steps/pr-narrative";
import { _prBodyDeps } from "@flows/nax-finish/steps/pr-body";
import { makeFlowCtx } from "@test/helpers";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };

const origRun = _prBodyDeps.run;
const origWarn = _prBodyDeps.warn;
afterEach(() => {
  _prBodyDeps.run = origRun;
  _prBodyDeps.warn = origWarn;
});

const ctxWith = (narrative?: unknown) =>
  makeFlowCtx({
    input: INPUT,
    outputs: { load_ctx: { route: "proceed", base: "origin/main" }, narrative },
  });

/**
 * A `run` that satisfies `detectForge` (GitHub remote) and records every argv,
 * so the amend path actually reaches `gh pr edit` instead of failing detection.
 */
const githubRun = (calls: string[][] = []) => async (cmd: string[]) => {
  calls.push(cmd);
  const isRemote = cmd.includes("remote");
  return { exitCode: 0, stdout: isRemote ? "git@github.com:acme/repo.git" : "", stderr: "" };
};

describe("amendPrBodyNode", () => {
  test("issues no forge call when the narrative node produced nothing", async () => {
    const calls: string[][] = [];
    _prBodyDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await amendPrBodyNode(ctxWith({ narrative: "" }));
    expect(out).toEqual({ route: "done", amended: false });
    expect(calls).toEqual([]);
  });

  test("treats a whitespace-only narrative as nothing", async () => {
    const out = await amendPrBodyNode(ctxWith({ narrative: "   \n  " }));
    expect(out.amended).toBe(false);
  });

  test("amends for a title even when the prose is empty", async () => {
    // The title is the part a reviewer reads first, so it alone justifies the
    // forge call that an empty narrative would otherwise skip.
    _prBodyDeps.run = githubRun();
    const out = await amendPrBodyNode(ctxWith({ narrative: "", title: "fix: repair the gate" }));
    expect(out.amended).toBe(true);
  });

  test("writes the model's title onto the PR", async () => {
    const calls: string[][] = [];
    _prBodyDeps.run = githubRun(calls);
    await amendPrBodyNode(ctxWith({ narrative: "Prose.", title: "fix: repair the gate" }));
    const edit = calls.find((c) => c.includes("--title"));
    expect(edit?.[edit.indexOf("--title") + 1]).toBe("fix: repair the gate");
  });

  test("falls back to 'feat: <feature>' when the node produced no title", async () => {
    const calls: string[][] = [];
    _prBodyDeps.run = githubRun(calls);
    await amendPrBodyNode(ctxWith({ narrative: "Prose." }));
    const edit = calls.find((c) => c.includes("--title"));
    expect(edit?.[edit.indexOf("--title") + 1]).toBe("feat: x");
  });

  test("warns instead of throwing when the forge edit fails", async () => {
    const warnings: string[] = [];
    _prBodyDeps.warn = (message) => warnings.push(message);
    _prBodyDeps.run = async () => {
      throw new Error("gh exploded");
    };
    const out = await amendPrBodyNode(ctxWith({ narrative: "real prose" }));
    expect(out).toEqual({ route: "done", amended: false });
    expect(warnings.length).toBe(1);
  });
});
