/**
 * Corpus of resolved permission asks (P2 design 7.2).
 *
 * One row is appended for EVERY resolved ask -- allow or deny, whichever link
 * answered. `decidedBy` distinguishes a human decision from the rest (cache,
 * model, timeout, unavailable, unshowable), so P5's classifier can select the
 * human-labelled ground-truth rows -- from the actual decision-maker, on the
 * real distribution -- out of the same file. P5's design records that such a
 * corpus does not exist; writing it now means P5 starts with labels rather
 * than bootstrapping them.
 *
 * One JSON object per line, mirroring finish-audit (src/finish/audit.ts:42).
 * String leaves pass through redactRowStrings so a secret in the request never
 * reaches the local corpus.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AskDecidedBy } from "./ask-chain";
import { redactRowStrings } from "./secret-spans";
import type { AskRequest } from "./types";

export interface ApprovalAuditRow {
  readonly request: AskRequest;
  readonly decision: "allow" | "deny";
  readonly decidedBy: AskDecidedBy;
  readonly latencyMs: number;
  readonly at: string;
}

export async function appendApprovalAudit(dir: string, runId: string, row: ApprovalAuditRow): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.jsonl`), `${JSON.stringify(redactRowStrings(row))}\n`, "utf8");
}
