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
  /**
   * Set only when a revert could not be confirmed — the worktree may still
   * hold an injected mutation for this story. Absent on every clean path.
   */
  readonly revertFailed?: true;
}
