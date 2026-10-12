/** A5 workflow mode — story-loop state and artifact shapes. */
export type {
  GateName,
  ImplementerReply,
  ImplementerStatus,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowFinding,
  WorkflowFindingDraft,
  WorkflowFindingKind,
  WorkflowSeverity,
} from "@/operations";

import type { GateName, WorkflowFinding, WorkflowFindingDraft } from "@/operations";

export type GateState = "green" | "red" | "skipped";

export interface GateRunResult {
  readonly red: boolean;
  readonly states: Readonly<Partial<Record<GateName, GateState>>>;
  readonly findings: readonly WorkflowFindingDraft[];
}

export type WorkflowEndState = "complete" | "complete-with-rulings" | "complete-gate-open";

export type WorkflowPhase = "implement" | "gates" | "review" | "fix" | "rereview" | "suite" | "residual" | "closed";

export interface WorkflowRuling {
  readonly findingId?: string;
  readonly action: "hold" | "waive" | "defer" | "carry";
  readonly text: string;
  readonly why: string;
  readonly costIfWrong: string;
  readonly source: "advisor" | "default";
  /** The advisor decision behind this ruling (absent for deterministic defaults). */
  readonly decisionId?: string;
  /** carry only: the dependent stories whose briefs receive the instruction. */
  readonly toStories?: readonly string[];
}

export interface WorkflowStoryRecord {
  readonly storyId: string;
  readonly state?: WorkflowEndState;
  readonly reason?: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly phase: WorkflowPhase;
  readonly reviewed: boolean;
  readonly unreviewed: boolean;
  readonly openFindings: readonly WorkflowFinding[];
  readonly nextFindingId: number;
  readonly deferredMinors: number;
  readonly rulings: number;
  readonly gates: Readonly<Partial<Record<GateName, GateState>>>;
  readonly timings: Readonly<Record<string, number>>;
  readonly startedAt: string;
  readonly endedAt?: string;
}

export interface WorkflowResultFile {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly feature: string;
  readonly stories: Readonly<Record<string, WorkflowStoryRecord>>;
}
