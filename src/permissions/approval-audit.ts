/**
 * Ground-truth corpus of human permission decisions (P2 design 7.2).
 *
 * Every human allow/deny on a real escalated command is a labelled example --
 * from the actual decision-maker, on the real distribution. P5's classifier
 * needs exactly this corpus and its design records that none exists; writing it
 * now means P5 starts with labels rather than bootstrapping them.
 *
 * One JSON object per line, mirroring finish-audit (src/finish/audit.ts:42).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AskDecidedBy } from "./ask-chain";
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
  await appendFile(join(dir, `${runId}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
}
