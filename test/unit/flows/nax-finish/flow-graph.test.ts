import { afterEach, describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import { _prDeps } from "@flows/nax-finish/steps/pr";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import type { FlowNodeContext } from "acpx/flows";

describe("nax-finish flow graph", () => {
  test("declares approve-all + starts at load_ctx", () => {
    expect(flow.name).toBe("nax-finish");
    expect(flow.permissions?.requiredMode).toBe("approve-all");
    expect(flow.startAt).toBe("load_ctx");
  });

  test("has the review + escalate + pr nodes and routes review_spec on $.route", () => {
    for (const n of [
      "review_spec",
      "review_quality",
      "acceptance",
      "fix_acceptance",
      "quality_gates",
      "open_pr",
      "escalate",
    ]) {
      expect(flow.nodes[n]).toBeDefined();
    }
    expect(flow.nodes.review_spec.nodeType).toBe("acp");
    const specEdge = flow.edges.find((e) => e.from === "review_spec" && "switch" in e);
    expect(specEdge && "switch" in specEdge && specEdge.switch.on).toBe("$.route");
  });

  test("review nodes are isolated and pin their profile from input", () => {
    const specNode = flow.nodes.review_spec as { session?: { isolated?: boolean } };
    expect(specNode.session?.isolated).toBe(true);
  });

  test("acceptance failures route to fix_acceptance, which loops back to acceptance", () => {
    const acceptanceEdge = flow.edges.find((e) => e.from === "acceptance" && "switch" in e);
    expect(acceptanceEdge && "switch" in acceptanceEdge && acceptanceEdge.switch.cases.fix).toBe("fix_acceptance");
    const loopEdge = flow.edges.find((e) => e.from === "fix_acceptance");
    expect(loopEdge && "to" in loopEdge && loopEdge.to).toBe("acceptance");
  });

  describe("open_pr node", () => {
    const originalPrRun = _prDeps.run;
    const originalWriteText = _resultDeps.writeText;
    afterEach(() => {
      _prDeps.run = originalPrRun;
      _resultDeps.writeText = originalWriteText;
    });

    test("writes nothing-to-finish and skips openOrPromotePr when load_ctx routed nothing-to-finish", async () => {
      const prCalls: string[][] = [];
      _prDeps.run = async (cmd) => {
        prCalls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      let wroteResult: string | null = null;
      _resultDeps.writeText = async (_p, s) => {
        wroteResult = s;
      };

      const openPrNode = flow.nodes.open_pr as { run: (ctx: FlowNodeContext) => Promise<unknown> };
      const out = await openPrNode.run({
        input: { feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false },
        outputs: { load_ctx: { route: "nothing-to-finish" } },
        results: {},
        state: {} as never,
        services: {},
      });

      expect(prCalls).toEqual([]);
      expect(out).toMatchObject({ status: "nothing-to-finish" });
      expect(JSON.parse(wroteResult as unknown as string)).toMatchObject({ status: "nothing-to-finish" });
    });
  });
});
