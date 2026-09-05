/**
 * Post-debate verifier strategy contract types.
 */

import type { CallContext } from "@/operations/types";
import type { SelectorResult } from "../selectors/types";
import type { DebateStageConfig } from "../types";

export interface PostDebateVerifierContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly selectorResult: SelectorResult;
  readonly workdir: string;
  readonly ctx: CallContext;
  /** Acceptance criteria from the story — used by post-debate verifiers to validate acIndex. */
  readonly acceptanceCriteria?: readonly string[];
  /** Blocking threshold used to classify review findings. */
  readonly blockingThreshold?: "error" | "warning" | "info";
}

export interface PostDebateVerifierResult {
  readonly outcome: "passed" | "failed" | "skipped";
  readonly findings?: unknown[];
  readonly output?: string;
  readonly costUsd: number;
}

export type PostDebateVerifier = (ctx: PostDebateVerifierContext) => Promise<PostDebateVerifierResult>;
