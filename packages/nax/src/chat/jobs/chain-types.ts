import type { ChatJobKind } from "./job-types";

export const CHAIN_ID_PATTERN = /^chain-[0-9a-f]{8}$/;
export const CHAIN_MAX_STEPS = 6;
export const CHAIN_CHECK_MAX_LENGTH = 200;
export const CHAIN_PR_PLACEHOLDER = "<pr>";

export type ChainState = "active" | "completed" | "stopped";

export interface ChainCheck {
  readonly passed: boolean;
  readonly note: string;
  readonly at: string;
}

export interface ChainStep {
  readonly kind: ChatJobKind;
  /** Exact argv; a PR-less bot step holds CHAIN_PR_PLACEHOLDER at prIndex. */
  readonly argv: readonly string[];
  readonly prIndex?: number;
  /** Feature name, decimal PR number, or empty when the agent chooses the PR. */
  readonly target: string;
  /** An in-session check that must pass before this step starts. */
  readonly checkBefore?: string;
  readonly check?: ChainCheck;
  /** Set once the step's job started. */
  readonly jobId?: string;
}

/** Machine-local audit record, not a restart/resume contract. */
export interface ChatChain {
  readonly schemaVersion: 1;
  readonly id: string;
  /** The chat session that approved it. */
  readonly sessionId: string;
  readonly cwd: string;
  readonly steps: readonly ChainStep[];
  readonly costCap?: number;
  /** The PR fixed by the first PR-less bot step that started. */
  readonly pr?: number;
  readonly approvedAt: string;
  readonly state: ChainState;
  readonly stopReason?: string;
  readonly endedAt?: string;
}
