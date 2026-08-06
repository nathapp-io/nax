import type { SurvivingMutant } from "../verification/mutation/types";

export interface MutationOutcomeSummary {
  readonly killed: number;
  readonly survived: number;
  readonly errored: number;
}

export interface MutationStorySummary {
  readonly storyId: string;
  readonly survivors: readonly SurvivingMutant[];
  readonly outcomes: MutationOutcomeSummary;
  readonly candidates: number;
  readonly checked: boolean;
}
