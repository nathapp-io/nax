export type ChatJobKind = "plan" | "run" | "bot_review" | "bot_fix";
export type ChatJobState = "running" | "succeeded" | "failed" | "cancelled" | "lost";

/** Machine-local job record, stored under the project's output directory. */
export interface ChatJob {
  readonly schemaVersion: 1;
  /** `<kind>-<8 lowercase hex>`, e.g. `run-1a2b3c4d`. */
  readonly id: string;
  readonly kind: ChatJobKind;
  /** Feature name for plan/run; the PR number as a decimal string for bot jobs. */
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
}

export const JOB_ID_PATTERN = /^(plan|run|bot_review|bot_fix)-[0-9a-f]{8}$/;
