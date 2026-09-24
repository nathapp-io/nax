/**
 * Pure formatters for `nax approvals list` (US-003).
 *
 * Two helpers only:
 *   - `formatTrustLine` — the second stdout line, distinguishing the
 *     `Cache: trusted` case from the three TAINTED shapes.
 *   - `formatEntryBlock` — the block printed per remembered approval: an
 *     entry line, a root line and one or more command lines, with the
 *     10/12-space indents the manual output documents.
 *
 * Everything byte-for-byte exactly as it is written to stdout. Both helpers
 * are kept pure (no I/O) so test/unit/cli/approvals-format.test.ts pins the
 * rendering independently of the dep-injected `approvalsListCommand` body.
 */

import { type ApprovalEntry, type ApprovalsTaint, approvalId } from "@/permissions";

/** Indent of the entry / root / `$ <cmd>` lines. */
const ENTRY_INDENT = " ".repeat(10);
/** Indent of the second and later lines of a multi-line command. */
const COMMAND_CONTINUATION_INDENT = " ".repeat(12);

/**
 * The trust line printed under `Approvals store: <path>`.
 *
 *   - untainted: `Cache: trusted`
 *   - taint whose pid is still alive: `(pid <pid>, alive)`
 *   - taint whose pid is gone: `(pid <pid>, exited)`
 *   - taint whose pid is unknown (malformed-on-disk): `(pid unknown)`
 *
 * `isAlive` is injected so a test can drive the alive vs exited branch
 * deterministically; the default in `_approvalsTaintDeps.isProcessAlive` uses
 * `process.kill(pid, 0)`.
 */
export function formatTrustLine(taint: ApprovalsTaint | undefined, isAlive: (pid: number) => boolean): string {
  if (taint === undefined) {
    return "Cache: trusted";
  }
  const { since, runId, pid } = taint;
  const pidFragment = pid === undefined ? "(pid unknown)" : `(pid ${pid}, ${isAlive(pid) ? "alive" : "exited"})`;
  const suffix = "-- the cache is OFF; a trusted run will discard these entries.";
  return `Cache: TAINTED since ${since} by run ${runId} ${pidFragment} ${suffix}`;
}

/**
 * The block for one remembered approval:
 *
 *   <approvalId>  <stage>  <origin>  <approvedAt>  <approvedBy>  naxCommit <naxCommit>
 *           root <root>
 *           $ <first command line>
 *             <second command line>   ← 12-space indent
 *             <...>                   ← 12-space indent
 *
 * Commands print RAW: secrets in the command line are not redacted (D20). A
 * missing or non-string `approvedAt` reads as the empty string so the line
 * shape is preserved.
 */
export function formatEntryBlock(entry: ApprovalEntry): readonly string[] {
  const header = `${approvalId(entry)}  ${entry.stage}  ${entry.origin}  ${entry.approvedAt ?? ""}  ${entry.approvedBy}  naxCommit ${entry.naxCommit}`;
  const rootLine = `${ENTRY_INDENT}root ${entry.root}`;
  const lines = entry.command.split("\n");
  const commandLines = lines.map((line, index) =>
    index === 0 ? `${ENTRY_INDENT}$ ${line}` : `${COMMAND_CONTINUATION_INDENT}${line}`,
  );
  return [header, rootLine, ...commandLines];
}
