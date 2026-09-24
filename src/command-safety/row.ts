/**
 * Appends one shadow row (spec 7.3). One JSON object per line, mirroring
 * src/permissions/approval-audit.ts. JSON.stringify escapes control
 * characters, so a command containing a newline still occupies one line.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandSafetyRow } from "./types";

export async function appendCommandSafetyRow(dir: string, runId: string, row: CommandSafetyRow): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
}
