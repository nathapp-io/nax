/**
 * `commit_<phase>` node behaviour: the message it writes, the round it records,
 * and the gate loop's re-entry into the quality review.
 *
 * Split out of `flow-graph.test.ts` (800-line test cap) — that file covers the
 * graph's shape and the other nodes' routing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import { _gitDeps } from "@flows/nax-finish/steps/git";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import type { FlowNodeContext } from "acpx/flows";

const INPUT = { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false };

const ctxOf = (over: { outputs?: Record<string, unknown>; steps?: { nodeId: string }[] }): FlowNodeContext =>
  ({
    input: INPUT,
    outputs: over.outputs ?? {},
    results: {},
    state: { steps: over.steps ?? [] } as never,
    services: {},
  }) as FlowNodeContext;

type NodeRun<T> = { run: (ctx: FlowNodeContext) => Promise<T> | T };
const nodeRun = <T>(id: string) => flow.nodes[id] as unknown as NodeRun<T>;
const switchOf = (from: string) => {
  const edge = flow.edges.find((e) => e.from === from && "switch" in e);
  if (!edge || !("switch" in edge)) throw new Error(`no switch edge from ${from}`);
  return edge.switch;
};

describe("commit_* nodes", () => {
  const originalRun = _gitDeps.run;
  const originalAppend = _resultDeps.appendText;
  afterEach(() => {
    _gitDeps.run = originalRun;
    _resultDeps.appendText = originalAppend;
  });

  const runCommitNode = async (id: string, porcelain: string, outputs: Record<string, unknown> = {}) => {
    const calls: string[][] = [];
    const rounds: unknown[] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--porcelain")
        ? { exitCode: 0, stdout: porcelain, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" };
    };
    _resultDeps.appendText = async (_p, s) => {
      rounds.push(JSON.parse(s));
    };
    const out = await nodeRun<{ committed: boolean; route: string }>(id).run(ctxOf({ outputs }));
    // The commit message is the last `-m` argument; asserting on it directly
    // keeps these tests readable now that it spans multiple lines.
    const commit = calls.find((c) => c[1] === "commit");
    return { out, argv: calls.map((c) => c.join(" ")), message: commit?.[3] ?? "", rounds };
  };

  test("commits the fix under a subject naming what was fixed, and does not push", async () => {
    const { out, message, argv } = await runCommitNode("commit_spec", " M apps/api/_calendar.py\n", {
      review_spec: {
        findings: [{ severity: "HIGH", title: "Market gate skip branch is unreachable", problem: "P", fix: "F" }],
      },
    });
    expect(out.committed).toBe(true);
    expect(message.split("\n")[0]).toBe("fix(x): market gate skip branch is unreachable");
    // The finding's detail belongs in the body — a PR reviewer reads it there.
    expect(message).toContain("- [HIGH] Market gate skip branch is unreachable");
    // --no-verify: a pre-commit hook rejecting an intermediate state would
    // otherwise kill the flow before the gate loop could fix it
    expect(argv.some((c) => c.endsWith("--no-verify"))).toBe(true);
    // the push belongs to the terminal nodes; a mid-loop push would publish
    // half-fixed states to the forge on every round
    expect(argv.some((c) => c.startsWith("git push"))).toBe(false);
  });

  // Regression: all six nax-finish commits on rs-stock/pipeline-run-outcome read
  // `fix(f): nax-finish <phase> fixes` with an empty body, so a PR reviewer could
  // not tell which one re-enabled a disabled market gate.
  test("no phase falls back to the old opaque 'nax-finish <phase> fixes' subject", async () => {
    for (const phase of ["acceptance", "spec", "quality", "gate"]) {
      const { message } = await runCommitNode(`commit_${phase}`, " M a.ts\n");
      expect(message.split("\n")[0]).not.toBe(`fix(x): nax-finish ${phase} fixes`);
      expect(message.split("\n")[0].startsWith("fix(x): ")).toBe(true);
    }
  });

  test("the gate phase names the failing commands in its subject", async () => {
    const { message } = await runCommitNode("commit_gate", " M a.ts\n", {
      quality_gates: { failing: ["lint", "test"], output: "1 failed" },
    });
    expect(message.split("\n")[0]).toBe("fix(x): repair failing lint and test gates");
  });

  test("a fix node that changed nothing produces no commit", async () => {
    const { out, argv } = await runCommitNode("commit_gate", "");
    expect(out.committed).toBe(false);
    expect(argv.some((c) => c.startsWith("git commit"))).toBe(false);
  });

  // ctx.outputs holds only the latest output per node, so a round not recorded
  // here is a round no terminal node can reconstruct.
  test("records the round to the audit trail, findings included", async () => {
    const { rounds } = await runCommitNode("commit_quality", " M a.ts\n", {
      review_quality: { findings: [{ severity: "CRITICAL", title: "T", problem: "P", fix: "F" }] },
    });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({
      phase: "quality",
      committed: true,
      findings: [{ severity: "CRITICAL", title: "T" }],
    });
  });

  test("records a round even when the fix committed nothing, so the dead round is visible", async () => {
    const { rounds } = await runCommitNode("commit_gate", "", { quality_gates: { failing: ["test"] } });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ phase: "gate", committed: false, failing: ["test"] });
  });
});

// Regression: the gate loop was the last loop to edit the tree and the only one
// whose edits nothing reviewed — `quality_gates` proves the repo's commands are
// green, which a bad fix can satisfy. rs-stock/pipeline-run-outcome shipped 8
// copy-pasted test stubs through this hole.
describe("gate fixes re-enter the quality review", () => {
  const gateSwitch = () => switchOf("commit_gate");

  test("a gate fix that committed goes back through review_quality", () => {
    expect(gateSwitch().cases.changed).toBe("review_quality");
  });

  test("a gate fix that changed nothing skips the re-review", () => {
    expect(gateSwitch().cases.unchanged).toBe("quality_gates");
  });

  test("the re-entry still terminates: review_quality's own fix loop keeps its escalate exit", () => {
    expect(switchOf("route_quality").cases.escalate).toBe("escalate");
    expect(switchOf("route_quality").cases.clean).toBe("quality_gates");
  });
});
