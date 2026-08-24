import type { DebateStageConfig } from "@/debate/types";

export function buildPlanComposition(userStageConfig: DebateStageConfig): DebateStageConfig {
  if (userStageConfig.evidenceMode !== "asymmetric") return userStageConfig;
  return {
    ...userStageConfig,
    preDebatePhase: userStageConfig.preDebatePhase ?? { kind: "grounder" },
    proposers: userStageConfig.proposers ?? { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
    sessionMode: userStageConfig.sessionMode ?? "stateful",
    selector: userStageConfig.selector ?? {
      kind: "verifier-pick",
      patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 },
    },
    postDebateVerifier: userStageConfig.postDebateVerifier ?? { kind: "plan-checklist" },
  };
}
