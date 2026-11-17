export type ChatJobKind = "plan" | "run" | "publish" | "bot_review" | "bot_fix";
export type ChatJobState = "running" | "succeeded" | "failed" | "cancelled" | "lost";

/** US-003: the draft PR a run or publish left behind, and what it is held by. */
export interface HeldDraft {
  readonly url?: string;
  /** The publish-time open items, in verdict order; empty when there are none or they could not be read. */
  readonly items: readonly { readonly id: string; readonly kind: string }[];
  /** Set when the open items could not be read; `items` is then empty. */
  readonly unreadable?: true;
}

/** Machine-local job record, stored under the project's output directory. */
export interface ChatJob {
  readonly schemaVersion: 1;
  /** `<kind>-<8 lowercase hex>`, e.g. `run-1a2b3c4d`. */
  readonly id: string;
  readonly kind: ChatJobKind;
  /** Feature name for plan/run/publish; the PR number as a decimal string for bot jobs. */
  readonly target: string;
  readonly argv: readonly string[];
  /** The repo root the job runs in. */
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly state: ChatJobState;
  readonly logPath: string;
  /** The chat session that started it. */
  readonly sessionId: string;
  /** When the user said yes on the launch card. */
  readonly approvedAt: string;
  readonly chainId?: string;
  /** 1-based index of this job's step in the approved chain. */
  readonly chainStep?: number;
  readonly cancelRequested?: true;
  readonly exitCode?: number;
  readonly cost?: number;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly note?: string;
  /** US-003: set when this run or publish left a draft PR, with the items the verdict still lists. */
  readonly held?: HeldDraft;
}

/**
 * `finish` is a legacy prefix only: records written before the job was renamed still carry it,
 * and `newJobId` never produces one.
 */
export const JOB_ID_PATTERN = /^(plan|run|publish|finish|bot_review|bot_fix)-[0-9a-f]{8}$/;

/** Kinds that target a feature and hold the checkout: plan, run, and publish (a publish-only run, #2819). */
export function isFeatureJobKind(kind: ChatJobKind): kind is "plan" | "run" | "publish" {
  return kind === "plan" || kind === "run" || kind === "publish";
}

/** Kinds that are a `nax run` process and so write the feature's run status file. */
export function isRunJobKind(kind: ChatJobKind): kind is "run" | "publish" {
  return kind === "run" || kind === "publish";
}
