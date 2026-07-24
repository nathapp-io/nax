import { afterEach, describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";
import { _acceptanceDeps } from "@flows/nax-finish/steps/acceptance";
import { _contextDeps } from "@flows/nax-finish/steps/context";
import { _prDeps } from "@flows/nax-finish/steps/pr";
import { _qualityDeps } from "@flows/nax-finish/steps/quality";
import { _resultDeps } from "@flows/nax-finish/steps/result";
import type { FlowNodeContext } from "acpx/flows";

const stepsCtx = (input: Record<string, unknown>, steps: { nodeId: string }[]): FlowNodeContext =>
  ({
    input,
    outputs: {},
    results: {},
    state: { steps } as never,
    services: {},
  }) as FlowNodeContext;

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

  test("review nodes are isolated and their profile is resolved from NAX_FINISH_*_PROFILE env vars at module load, not flow input", () => {
    const specNode = flow.nodes.review_spec as { session?: { isolated?: boolean } };
    expect(specNode.session?.isolated).toBe(true);
  });

  test("acceptance failures route to fix_acceptance, which loops back to acceptance", () => {
    const acceptanceEdge = flow.edges.find((e) => e.from === "acceptance" && "switch" in e);
    expect(acceptanceEdge && "switch" in acceptanceEdge && acceptanceEdge.switch.cases.fix).toBe("fix_acceptance");
    const loopEdge = flow.edges.find((e) => e.from === "fix_acceptance");
    expect(loopEdge && "to" in loopEdge && loopEdge.to).toBe("acceptance");
  });

  test("acceptance and quality_gates fix loops have an escalate case, so a runaway loop can exit", () => {
    const acceptanceEdge = flow.edges.find((e) => e.from === "acceptance" && "switch" in e);
    expect(acceptanceEdge && "switch" in acceptanceEdge && acceptanceEdge.switch.cases.escalate).toBe("escalate");
    const qualityEdge = flow.edges.find((e) => e.from === "quality_gates" && "switch" in e);
    expect(qualityEdge && "switch" in qualityEdge && qualityEdge.switch.cases.escalate).toBe("escalate");
  });

  describe("acceptance node — fix-loop escalation cap", () => {
    const originalContextRun = _contextDeps.run;
    const originalAcceptanceRun = _acceptanceDeps.run;
    afterEach(() => {
      _contextDeps.run = originalContextRun;
      _acceptanceDeps.run = originalAcceptanceRun;
    });

    const groups = [
      {
        packageDir: "",
        testPath: ".nax/features/x/a.test.ts",
        exists: true,
        command: "bun test {{FILE}}",
        language: "typescript",
      },
    ];

    test("still under the cap routes to fix, not escalate", async () => {
      _contextDeps.run = async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ acceptance: { status: "ok", groups } }),
        stderr: "",
      });
      _acceptanceDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "still failing" });

      const acceptanceNode = flow.nodes.acceptance as { run: (ctx: FlowNodeContext) => Promise<{ route: string }> };
      const out = await acceptanceNode.run(
        stepsCtx({ feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false }, [
          { nodeId: "fix_acceptance" },
          { nodeId: "fix_acceptance" },
        ]),
      );

      expect(out.route).toBe("fix");
    });

    test("at the cap routes to escalate with a reason", async () => {
      _contextDeps.run = async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ acceptance: { status: "ok", groups } }),
        stderr: "",
      });
      _acceptanceDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "still failing" });

      const acceptanceNode = flow.nodes.acceptance as {
        run: (ctx: FlowNodeContext) => Promise<{ route: string; reason?: string }>;
      };
      const out = await acceptanceNode.run(
        stepsCtx({ feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false }, [
          { nodeId: "fix_acceptance" },
          { nodeId: "fix_acceptance" },
          { nodeId: "fix_acceptance" },
        ]),
      );

      expect(out.route).toBe("escalate");
      expect(out.reason).toContain("3 fix attempts");
    });
  });

  describe("quality_gates node — fix-loop escalation cap", () => {
    const originalQualityRun = _qualityDeps.run;
    const originalQualityReadText = _qualityDeps.readText;
    afterEach(() => {
      _qualityDeps.run = originalQualityRun;
      _qualityDeps.readText = originalQualityReadText;
    });

    test("at the cap routes to escalate with a reason naming the failing gates", async () => {
      _qualityDeps.readText = async () => JSON.stringify({ quality: { commands: { lint: "bun run lint" } } });
      _qualityDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "lint bad" });

      const qualityGatesNode = flow.nodes.quality_gates as {
        run: (ctx: FlowNodeContext) => Promise<{ route: string; reason?: string }>;
      };
      const out = await qualityGatesNode.run(
        stepsCtx({ feature: "x", workdir: "/repo", branch: "feat/x", prdPath: "p", escalateTelegram: false }, [
          { nodeId: "fix_gate" },
          { nodeId: "fix_gate" },
          { nodeId: "fix_gate" },
        ]),
      );

      expect(out.route).toBe("escalate");
      expect(out.reason).toContain("lint");
    });
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
