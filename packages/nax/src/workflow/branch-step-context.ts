import type { NaxConfig, WorkflowConfig } from "@/config";
import type { ForgeKind } from "@/forge";
import type { CallContext } from "@/operations";

/** What the branch steps read: inside a run FeatureContext provides it, outside a run buildPrStepContext. */
export interface BranchStepContext {
  readonly callCtx: CallContext;
  readonly config: NaxConfig;
  readonly workflow: WorkflowConfig;
  /** The feature name inside a run; `bot-pr-<number>` for a PR. Used in report headings and logs. */
  readonly feature: string;
  /** Repo root (git cwd). */
  readonly projectDir: string;
  /** Where review packages, step artifacts and the report go. */
  readonly runDir: string;
  readonly reportPath: string;
  /** Absent outside a run: the change has no PRD. */
  readonly prdPath?: string;
  /** Repo-relative package dirs for the repo gates; empty = root gates only. */
  readonly packageDirs: readonly string[];
  readonly runSignal?: AbortSignal;
  readonly dryRun: boolean;
}

export interface PrStepRef {
  readonly forge: ForgeKind;
  readonly number: number;
  /** The base commit or ref the review range starts at. */
  readonly base: string;
  /** The PR head commit sha. */
  readonly head: string;
}

export interface PrStepContext extends BranchStepContext {
  readonly pr: PrStepRef;
}
