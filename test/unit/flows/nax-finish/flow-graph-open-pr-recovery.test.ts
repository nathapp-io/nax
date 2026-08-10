/**
 * `open_pr` when the network half fails.
 *
 * acpx has no error edge, so a node that throws kills the flow — and `open_pr`
 * is the last node on the happy path, reached only after every gate is green
 * and every fix has landed. A throw there left no result file at all, so the
 * plugin reported "flow produced no result file" and notified nobody: #1399's
 * failure mode, which `escalate` was hardened against and this node was not.
 *
 * Both failures must route to `escalate` (which writes a result, pushes what it
 * can, and delivers) rather than propagate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import { _gitDeps } from "@flows/nax-finish/steps/git";
import { _prDeps } from "@flows/nax-finish/steps/pr";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import { makeFlowCtx } from "@test/helpers";
import type { FlowNodeContext } from "acpx/flows";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };
const ctxOf = (outputs: Record<string, unknown>): FlowNodeContext => makeFlowCtx({ input: INPUT, outputs });
const openPr = flow.nodes.open_pr as unknown as {
  run: (ctx: FlowNodeContext) => Promise<{ route: string; reason?: string; status?: string }>;
};

const originalPrRun = _prDeps.run;
const originalGitRun = _gitDeps.run;
const originalWriteText = _resultDeps.writeText;
afterEach(() => {
  _prDeps.run = originalPrRun;
  _gitDeps.run = originalGitRun;
  _resultDeps.writeText = originalWriteText;
});

/** A forge that answers every probe happily, so only the push can fail. */
const happyForge = async (cmd: string[]) =>
  cmd.join(" ").includes("remote get-url")
    ? { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" }
    : { exitCode: 0, stdout: JSON.stringify({ isDraft: false, url: "https://gh/pr/1" }), stderr: "" };

describe("open_pr — failure routing", () => {
  test("a rejected push escalates instead of killing the flow with no result", async () => {
    _gitDeps.run = async (cmd) => {
      if (cmd.includes("--porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd.includes("push"))
        return { exitCode: 1, stdout: "", stderr: "! [remote rejected] feat/x -> feat/x (protected branch hook)" };
      return { exitCode: 0, stdout: "sha", stderr: "" };
    };
    _prDeps.run = happyForge;
    _resultDeps.writeText = async () => {};

    const out = await openPr.run(ctxOf({ load_ctx: { route: "proceed", base: "origin/main" } }));

    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("push");
    expect(out.reason).toContain("feat/x");
  });

  test("a forge that refuses to open the PR escalates rather than throwing", async () => {
    _gitDeps.run = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    _prDeps.run = async (cmd) => {
      if (cmd.join(" ").includes("remote get-url")) return { exitCode: 0, stdout: "git@github.com:o/r", stderr: "" };
      if (cmd.includes("view")) return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
      return { exitCode: 1, stdout: "", stderr: "GraphQL: was submitted too quickly (rate limit)" };
    };
    _resultDeps.writeText = async () => {};

    const out = await openPr.run(ctxOf({ load_ctx: { route: "proceed", base: "origin/main" } }));

    expect(out.route).toBe("escalate");
    expect(out.reason).toContain("feat/x");
  });

  test("the escalate route has an edge to the escalate node — otherwise the switch dead-ends", () => {
    const edge = flow.edges.find((e) => e.from === "open_pr" && "switch" in e);
    if (!edge || !("switch" in edge)) throw new Error("no switch edge from open_pr");
    expect(edge.switch.cases.escalate).toBe("escalate");
  });

  test("load_ctx can escalate too, so an unresolvable base is not read as nothing-to-finish", () => {
    const edge = flow.edges.find((e) => e.from === "load_ctx" && "switch" in e);
    if (!edge || !("switch" in edge)) throw new Error("no switch edge from load_ctx");
    expect(edge.switch.cases.escalate).toBe("escalate");
  });
});

/**
 * Whole-graph invariants, asserted once rather than per edge.
 *
 * A switch case naming a node that does not exist dead-ends only when that
 * route is taken — and the routes added here are the failure paths, which no
 * happy-path test ever walks. `finish_done` exists solely because acpx requires
 * a real node for every case, so this is the rule the graph is already built
 * around; nothing checked it.
 */
describe("flow graph integrity", () => {
  const targetsOf = (edge: (typeof flow.edges)[number]): string[] =>
    "to" in edge ? [edge.to] : Object.values(edge.switch.cases);

  test("every edge target names a declared node", () => {
    const declared = new Set(Object.keys(flow.nodes));
    const dangling = flow.edges.flatMap((e) =>
      targetsOf(e)
        .filter((t) => !declared.has(t))
        .map((t) => `${e.from} -> ${t}`),
    );
    expect(dangling).toEqual([]);
  });

  test("every declared node is reachable from the start node", () => {
    const reachable = new Set([flow.startAt]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const edge of flow.edges) {
        if (!reachable.has(edge.from)) continue;
        for (const target of targetsOf(edge)) {
          if (!reachable.has(target)) {
            reachable.add(target);
            grew = true;
          }
        }
      }
    }
    expect(Object.keys(flow.nodes).filter((n) => !reachable.has(n))).toEqual([]);
  });
});
