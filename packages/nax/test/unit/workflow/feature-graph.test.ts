import { describe, expect, test } from "bun:test";
import { makeFeatureMachineHarness } from "@test/helpers";
import { validateStepGraph } from "@/step-graph";
import { FEATURE_GRAPH } from "@/workflow/feature-graph";

describe("FEATURE_GRAPH", () => {
  test("declares valid nodes and destinations for the workflow", () => {
    expect(validateStepGraph(FEATURE_GRAPH)).toEqual({ errors: [] });
    expect(FEATURE_GRAPH.start).toBe("repo-gates");
    expect(FEATURE_GRAPH.end).toEqual(["done"]);
    expect(
      Object.entries(FEATURE_GRAPH.nodes)
        .filter(([, n]) => n?.kind === "agent")
        .map(([id]) => id)
        .sort(),
    ).toEqual(["adjudicate", "branch-fix", "branch-rereview", "branch-review", "gate-repair"]);
    expect(
      Object.entries(FEATURE_GRAPH.nodes)
        .filter(([, n]) => n?.commits)
        .map(([id]) => id)
        .sort(),
    ).toEqual(["branch-fix", "gate-repair", "publish"]);
    expect(FEATURE_GRAPH.costStopProduces).toEqual(["costLimited"]);
    expect(FEATURE_GRAPH.nodes["branch-fix"]?.produces).toEqual(["fixBase", "fixRan", "fixRounds"]);
    expect(FEATURE_GRAPH.nodes["branch-fix"]?.transitions.map(({ on, to }) => ({ on, to }))).toEqual([
      { on: "nothing-to-fix", to: "branch-rereview" },
      { on: "capped", to: "adjudicate" },
      { on: "no-base", to: "adjudicate" },
      { on: "fixed", to: "branch-rereview" },
    ]);
  });

  test("cost-stops only agent work and records a non-mirrored ledger note", async () => {
    const harness = makeFeatureMachineHarness({});
    const env = harness.env;
    const record = {
      ...env.record,
      reviewOpen: [{ id: "B1", kind: "quality" as const, severity: "important" as const, issue: "issue" }],
    };
    const notes: { text: string; options?: { mirror?: boolean } }[] = [];
    const stoppingEnv = {
      ...env,
      sink: {
        ...env.sink,
        ledger: async (text: string, options?: { mirror?: boolean }) => {
          notes.push({ text, options });
        },
      },
    };
    expect(await FEATURE_GRAPH.costStop?.("branch-fix", record, stoppingEnv)).toEqual({
      patch: { costLimited: true },
      to: "final-gates",
    });
    expect(notes).toEqual([
      { text: expect.stringContaining("cost limit reached: branch-fix skipped"), options: { mirror: false } },
    ]);
    notes.length = 0;
    expect(await FEATURE_GRAPH.costStop?.("adjudicate", { ...record, reviewOpen: [] }, stoppingEnv)).toBeUndefined();
    expect(await FEATURE_GRAPH.costStop?.("branch-review", { ...record, seed: null }, stoppingEnv)).toBeUndefined();
    expect(notes).toEqual([]);
  });
});
