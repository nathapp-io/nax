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

describe("amendPrBodyNode", () => {
  test("issues no forge call when the narrative node produced nothing", async () => {
    const calls: string[][] = [];
    _prBodyDeps.run = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const out = await amendPrBodyNode(ctxWith(undefined));
    expect(out).toEqual({ route: "done", amended: false });
    expect(calls).toEqual([]);
  });

  test("treats a whitespace-only narrative as nothing", async () => {
    const out = await amendPrBodyNode(ctxWith("   \n  "));
    expect(out.amended).toBe(false);
  });

  test("warns instead of throwing when the forge edit fails", async () => {
    const warnings: string[] = [];
    _prBodyDeps.warn = (message) => warnings.push(message);
    _prBodyDeps.run = async () => {
      throw new Error("gh exploded");
    };
    const out = await amendPrBodyNode(ctxWith("real prose"));
    expect(out).toEqual({ route: "done", amended: false });
    expect(warnings.length).toBe(1);
  });
});
