import { describe, expect, test } from "bun:test";
import type { DebateStageConfig } from "@/debate/types";
import { buildPlanComposition } from "@/plan";

function makeBaseStageConfig(
  overrides: Partial<DebateStageConfig> & { evidenceMode?: "current" | "asymmetric" } = {},
): DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    rounds: 1,
    ...overrides,
  } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };
}

describe("buildPlanComposition", () => {
  test("applies the asymmetric plan-stage defaults when evidenceMode is asymmetric", () => {
    const input = {
      ...makeBaseStageConfig({
        evidenceMode: "asymmetric",
        debaters: [{ agent: "claude" }],
      }),
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    expect(buildPlanComposition(input)).toEqual({
      ...input,
      preDebatePhase: { kind: "grounder" },
      proposers: { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
      sessionMode: "stateful",
      selector: {
        kind: "verifier-pick",
        patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 },
      },
      postDebateVerifier: { kind: "plan-checklist" },
    });
  });

  test("preserves explicit asymmetric overrides instead of replacing them", () => {
    const input = {
      ...makeBaseStageConfig({
        evidenceMode: "asymmetric",
        sessionMode: "one-shot",
        preDebatePhase: { kind: "custom", onFailure: "block" },
        proposers: { citationsRequired: false, fileReadAccess: false, fileReadBudget: 2 },
        selector: { kind: "synthesis" },
        postDebateVerifier: { kind: "custom", onBlocker: "tag-expert" },
      }),
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    expect(buildPlanComposition(input)).toEqual({
      ...input,
      sessionMode: "one-shot",
      preDebatePhase: { kind: "custom", onFailure: "block" },
      proposers: { citationsRequired: false, fileReadAccess: false, fileReadBudget: 2 },
      selector: { kind: "synthesis" },
      postDebateVerifier: { kind: "custom", onBlocker: "tag-expert" },
    });
  });
});
