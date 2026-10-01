/**
 * Appends one shadow row (spec 7.3). One JSON object per line, mirroring
 * src/permissions/approval-audit.ts. JSON.stringify escapes control
 * characters, so a command containing a newline still occupies one line.
 * String leaves pass through redactRowStrings so a secret in the command is
 * masked in the row while shell syntax after the span stays forensic.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { redactRowStrings } from "@/permissions";
import type { CommandSafetyRow } from "./types";

export async function appendCommandSafetyRow(dir: string, runId: string, row: CommandSafetyRow): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.jsonl`), `${JSON.stringify(redactRowStrings(row))}\n`, "utf8");
}
