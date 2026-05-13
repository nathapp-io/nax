import type { DebateStageConfig } from "../../debate/types";

export function buildPlanComposition(
  userStageConfig: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" },
): DebateStageConfig {
  return userStageConfig;
}
