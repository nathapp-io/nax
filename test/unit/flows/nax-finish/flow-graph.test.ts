import { describe, expect, test } from "bun:test";
import flow from "@flows/nax-finish/nax-finish.flow";

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
});
