/**
 * The publish step's ledger commits (US-003, US-007, nax#2646): the pre-push commit the PR body's
 * rulings depend on, and the local commit of the approval ruling written after it.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { ledgerPath } from "@/advisor";
import { getSafeLogger } from "@/logger";
import type { FeatureContext } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import type { ApprovalOutcome } from "./types";

/** What one ledger commit attempt did. */
interface LedgerCommitResult {
  /** Non-empty ledger lines the branch lacks because the attempt failed; 0 when it landed or the ledger is empty. */
  readonly missingRulings: number;
}

const LEDGER_MISSING_PREFIX = "advisor ledger not committed:";

/** Non-empty lines in the feature's ledger on disk; 0 when it is absent or unreadable. */
async function ledgerLineCount(fc: FeatureContext): Promise<number> {
  try {
    const file = Bun.file(ledgerPath(fc.projectDir, fc.feature));
    return (await file.exists()) ? nonEmptyLineCount(await file.text()) : 0;
  } catch {
    return 0;
  }
}

/** A blank line is not a ruling, so only non-empty lines count. */
function nonEmptyLineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * The ledger-only commit, fail-open (US-003). The rulings the PR body cites have to be on the pushed
 * branch, but a git failure or a locked index must never change what publishing does — so a throw is
 * logged and read as "no commit was made".
 *
 * US-007 (nax#2534): the failure is now loud about its consequence. A ledger the branch does not carry
 * means the PR cites rulings nothing backs up, so the caller turns `missingRulings` into a readiness
 * reason and the PR stays a draft. The count is the ledger on disk, since the lines that were never
 * committed are exactly the ones the reader of the PR cannot see.
 */
export async function ledgerCommit(fc: FeatureContext): Promise<LedgerCommitResult> {
  if (fc.dryRun) return { missingRulings: 0 };
  try {
    await _featureDeps.commitLedger(fc.projectDir, fc.feature);
    return { missingRulings: 0 };
  } catch (err) {
    const missingRulings = await ledgerLineCount(fc);
    const message =
      missingRulings > 0
        ? `Advisor ledger commit failed — the branch is missing ${missingRulings} advisor rulings`
        : "Advisor ledger commit failed — publishing continues";
    getSafeLogger()?.warn("workflow", message, { storyId: "_run", error: errorMessage(err) });
    return { missingRulings };
  }
}

/** The readiness reason a failed ledger commit contributes; empty when the commit landed or had nothing to commit. */
export function ledgerReasons(ledger: LedgerCommitResult): string[] {
  return ledger.missingRulings > 0 ? [ledgerMissingReason(ledger.missingRulings)] : [];
}

function ledgerMissingReason(missingRulings: number): string {
  return `${LEDGER_MISSING_PREFIX} the branch is missing ${missingRulings} advisor rulings`;
}

/**
 * nax#2646: `askApproval` appends its ruling after the pushed ledger commit, so the ruling gets a local
 * commit of its own. It is never pushed (#2629: an approved PR runs CI once) and rides the next push.
 * Without a known pushed head nothing is committed, so threads never cite an unpushed sha. Fail-open
 * like `ledgerCommit`; true only when a commit moved HEAD past the pushed head.
 */
export async function commitApprovalRuling(
  fc: FeatureContext,
  approval: ApprovalOutcome | null,
  pushedHead: string | undefined,
): Promise<boolean> {
  if (fc.dryRun || !pushedHead || approval?.decisionId === undefined) return false;
  try {
    return await _featureDeps.commitLedger(fc.projectDir, fc.feature);
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Advisor approval ruling not committed — it stays in the working tree", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return false;
  }
}
