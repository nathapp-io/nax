import type { Finding } from "@/findings";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import type { QuarantineMemo } from "@/verification";
import type { TriageSeam } from "./flake-triage-seam";
import { extractPhaseFindings, gateFindingKey } from "./phase-eval";

export interface CreateNbfFlakeTriageTransactionInput {
  readonly baseMemo?: QuarantineMemo;
  readonly baselineKeys: ReadonlySet<string>;
}

/** Transaction-local flake state for one ADR-024 best-effort pass. */
export interface NbfFlakeTriageTransaction {
  readonly memo: QuarantineMemo;
  readonly flakeTriageRan: boolean;
  candidates(findings: readonly Finding[]): Finding[];
  recordAttempt(findings: readonly Finding[], ran: boolean): void;
  commit(): void;
}

interface CandidateInput {
  readonly finding: Finding;
  readonly transactionInput: CreateNbfFlakeTriageTransactionInput;
  readonly memo: QuarantineMemo;
  readonly attemptedKeys: ReadonlySet<string>;
}

function isCandidate(input: CandidateInput): boolean {
  if (input.finding.source !== "test-runner" || input.finding.category !== "failed-test") return false;
  const key = gateFindingKey(input.finding);
  return !input.transactionInput.baselineKeys.has(key) && !input.memo.has(key) && !input.attemptedKeys.has(key);
}

export function createNbfFlakeTriageTransaction(
  input: CreateNbfFlakeTriageTransactionInput,
): NbfFlakeTriageTransaction {
  const pendingKeys = new Set<string>();
  const attemptedKeys = new Set<string>();
  let flakeTriageRan = false;
  const memo: QuarantineMemo = {
    has: (key) => pendingKeys.has(key) || input.baseMemo?.has(key) === true,
    add: (key) => pendingKeys.add(key),
  };

  return {
    memo,
    get flakeTriageRan() {
      return flakeTriageRan;
    },
    candidates: (findings) =>
      findings.filter((finding) => isCandidate({ finding, transactionInput: input, memo, attemptedKeys })),
    recordAttempt: (findings, ran) => {
      if (!ran) return;
      flakeTriageRan = true;
      for (const finding of findings) attemptedKeys.add(gateFindingKey(finding));
    },
    commit: () => {
      for (const key of pendingKeys) input.baseMemo?.add(key);
    },
  };
}

interface TriageNbfGateInput {
  readonly output: unknown;
  readonly gateName: string;
  readonly ctx: CallContext;
  readonly transaction: NbfFlakeTriageTransaction;
  readonly triage: TriageSeam;
}

/** Probe NBF-only failures without rewriting the gate output or the run memo. */
export async function triageNbfGate(input: TriageNbfGateInput): Promise<void> {
  const candidates = input.transaction.candidates(extractPhaseFindings(input.output));
  if (candidates.length === 0) return;
  const record = input.output as Record<string, unknown>;
  const rawOutput = typeof record.rawOutput === "string" ? record.rawOutput : "";
  try {
    const [, report] = await input.triage(candidates, {
      ctx: input.ctx,
      rawOutput,
      quarantineMemo: input.transaction.memo,
    });
    const ran = report.flakeTriageRan ?? true;
    if (ran) {
      for (const key of report.quarantinedKeys) input.transaction.memo.add(key);
    }
    input.transaction.recordAttempt(candidates, ran);
  } catch (err) {
    getSafeLogger()?.warn("story-orchestrator", "NBF flake triage threw — keeping findings blocking", {
      storyId: input.ctx.storyId,
      gateName: input.gateName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
