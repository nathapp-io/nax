/**
 * Curator Plugin Types
 *
 * Defines observation schema and curator-specific types for Phase 1 collection.
 */

import type { NaxConfig } from "../../../config";
import type { PostRunContext } from "../../extensions";

/** Curator configuration with thresholds */
export interface CuratorThresholds {
  repeatedFinding: number;
  emptyKeyword: number;
  rectifyAttempts: number;
  escalationChain: number;
  staleChunkRuns: number;
  unchangedOutcome: number;
}

/** Extended curator config interface */
export interface CuratorConfigExt {
  enabled: boolean;
  rollupPath?: string;
  thresholds: CuratorThresholds;
}

/** Base observation shape */
export interface BaseObservation {
  schemaVersion: 1;
  runId: string;
  featureId: string;
  storyId: string;
  stage: string;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** Chunk included observation */
export interface ChunkIncludedObservation extends BaseObservation {
  kind: "chunk-included";
  payload: {
    chunkId: string;
    label: string;
    tokens: number;
  };
}

/** Chunk excluded observation */
export interface ChunkExcludedObservation extends BaseObservation {
  kind: "chunk-excluded";
  payload: {
    chunkId: string;
    label: string;
    reason?: string;
  };
}

/** Provider empty observation */
export interface ProviderEmptyObservation extends BaseObservation {
  kind: "provider-empty";
  payload: {
    provider: string;
    reason?: string;
  };
}

/** Review finding observation */
export interface ReviewFindingObservation extends BaseObservation {
  kind: "review-finding";
  payload: {
    ruleId: string;
    severity: string;
    file: string;
    line: number;
    message: string;
  };
}

/** Rectify cycle observation */
export interface RectifyCycleObservation extends BaseObservation {
  kind: "rectify-cycle";
  payload: {
    iteration: number;
    status: "started" | "failed" | "passed";
  };
}

/** Escalation observation */
export interface EscalationObservation extends BaseObservation {
  kind: "escalation";
  payload: {
    from: string;
    to: string;
  };
}

/** Acceptance verdict observation */
export interface AcceptanceVerdictObservation extends BaseObservation {
  kind: "acceptance-verdict";
  payload: {
    passed: number;
    failed: number;
  };
}

/** Pull call observation */
export interface PullCallObservation extends BaseObservation {
  kind: "pull-call";
  payload: {
    toolName: string;
    status: "started" | "completed" | "failed";
  };
}

/** Co-change observation */
export interface CoChangeObservation extends BaseObservation {
  kind: "co-change";
  payload: {
    file: string;
    relatedFiles: string[];
  };
}

/** Verdict observation */
export interface VerdictObservation extends BaseObservation {
  kind: "verdict";
  payload: {
    status: "completed" | "failed" | "skipped";
    cost: number;
    tokens: number;
  };
}

/** Fix cycle iteration observation */
export interface FixCycleIterationObservation extends BaseObservation {
  kind: "fix-cycle-iteration";
  payload: {
    iteration: number;
    status: "started" | "passed" | "failed";
  };
}

/** Fix cycle exit observation */
export interface FixCycleExitObservation extends BaseObservation {
  kind: "fix-cycle-exit";
  payload: {
    reason: string;
    finalStatus: string;
  };
}

/** Fix cycle validator retry observation */
export interface FixCycleValidatorRetryObservation extends BaseObservation {
  kind: "fix-cycle-validator-retry";
  payload: {
    retryCount: number;
    reason: string;
  };
}

/** Union of all observation types */
export type Observation =
  | ChunkIncludedObservation
  | ChunkExcludedObservation
  | ProviderEmptyObservation
  | ReviewFindingObservation
  | RectifyCycleObservation
  | EscalationObservation
  | AcceptanceVerdictObservation
  | PullCallObservation
  | CoChangeObservation
  | VerdictObservation
  | FixCycleIterationObservation
  | FixCycleExitObservation
  | FixCycleValidatorRetryObservation;

/** Extended post-run context for curator */
export interface CuratorPostRunContext extends PostRunContext {
  config: NaxConfig;
  outputDir: string;
  globalDir: string;
  projectKey: string;
  curatorRollupPath: string;
  logFilePath?: string;
}
