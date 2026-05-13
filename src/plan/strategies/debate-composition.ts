import type { DebateStageConfig } from "../../debate/types";

export function buildPlanComposition(
  userStageConfig: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" },
): DebateStageConfig {
  if (userStageConfig.evidenceMode !== "asymmetric") return userStageConfig;
  const hasExplicitAsymmetricOverrides =
    userStageConfig.preDebatePhase !== undefined ||
    userStageConfig.proposers !== undefined ||
    userStageConfig.selector !== undefined ||
    userStageConfig.postDebateVerifier !== undefined;
  return {
    ...userStageConfig,
    preDebatePhase: userStageConfig.preDebatePhase ?? { kind: "grounder" },
    proposers: userStageConfig.proposers ?? { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
    sessionMode: hasExplicitAsymmetricOverrides ? userStageConfig.sessionMode : "stateful",
    selector: userStageConfig.selector ?? {
      kind: "verifier-pick",
      patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 },
    },
    postDebateVerifier: userStageConfig.postDebateVerifier ?? { kind: "plan-checklist" },
  };
}
