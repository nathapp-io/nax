/**
 * Pure formatters for `nax approvals` (US-003, extended by US-004/US-005).
 *
 * Four helpers, all pure (no I/O):
 *   - `formatTrustLine` — the second stdout line, distinguishing the
 *     `Cache: trusted` case from the three TAINTED shapes.
 *   - `formatEntryBlock` — the block printed per remembered approval: an
 *     entry line, a root line and one or more command lines, with the
 *     10/12-space indents the manual output documents.
 *   - `toListJson` — the `nax approvals list --json` body (US-004).
 *   - `formatRemovedLine` — the `removed <id>  <stage>  <preview>` line
 *     printed per revoked entry (US-005).
 *
 * Formatting is byte-for-byte for printable text. Secret values in a command
 * are not redacted (D20), but every displayed field is passed through
 * `stripControlChars` so a forged store entry cannot inject ANSI/escape
 * sequences into the operator's terminal (SEC-09) — that is terminal safety,
 * not secret masking. The helpers live here rather than in `approvals.ts` so
 * neither file nears the line gate and the rendering can be pinned
 * independently of the dep-injected command bodies.
 */

import { type ApprovalEntry, type ApprovalsFileRead, type ApprovalsTaint, approvalId } from "@/permissions";
import { stripControlChars } from "@/utils/strip-control-chars";

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
  return `Cache: TAINTED since ${stripControlChars(since)} by run ${stripControlChars(runId)} ${pidFragment} ${suffix}`;
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
 * missing or non-string field reads as the empty string so the line shape is
 * preserved AND so the printed value agrees with the preimage `approvalId`
 * uses (it coerces non-strings to ""; otherwise a header field and its
 * derived id disagree on what the entry's effective field is).
 *
 * Every displayed value is passed through `stripControlChars` (SEC-09): the
 * store is forgeable, so a crafted entry must not be able to emit ANSI/OSC
 * sequences into the operator's terminal. Newlines remain untouched, so a
 * multi-line command still renders as the documented block.
 *
 * `isApprovalEntry` only requires `stage`/`command` be strings (US-001),
 * which means a file written with other fields missing or non-string still
 * reads as `state: "ok"` — this hardening keeps the printed shape stable.
 */
export function formatEntryBlock(entry: ApprovalEntry): readonly string[] {
  const str = (value: unknown): string => stripControlChars(typeof value === "string" ? value : "");
  const header = `${approvalId(entry)}  ${str(entry.stage)}  ${str(entry.origin)}  ${str(entry.approvedAt)}  ${str(entry.approvedBy)}  naxCommit ${str(entry.naxCommit)}`;
  const rootLine = `${ENTRY_INDENT}root ${str(entry.root)}`;
  // A CRLF command (`"a\r\nb"`) would otherwise leave a literal `\r` on the
  // first line that a real terminal interprets as "overwrite line start" and
  // corrupts the displayed command. Splitting on `\r?\n` strips the carriage
  // return without changing a clean-LF command. Each line is then stripped of
  // the remaining control/escape sequences (SEC-09) before it is printed.
  const lines = entry.command.split(/\r?\n/).map((line) => stripControlChars(line));
  const commandLines = lines.map((line, index) =>
    index === 0 ? `${ENTRY_INDENT}$ ${line}` : `${COMMAND_CONTINUATION_INDENT}${line}`,
  );
  return [header, rootLine, ...commandLines];
}

/**
 * The `--json` body: one plain object with exactly the keys
 * `path`, `state`, `taint`, `droppedMalformed` and `entries` (US-004).
 *
 * `state` is the read's classification: `"missing"`, `"unparseable"` or `"ok"`.
 * `taint` is `null` when the store has none and the read's taint otherwise.
 * `entries` lists `{ ...entry, id: approvalId(entry) }` — the id is computed
 * from (stage, command, approvedAt), so re-deriving it here lets a JSON
 * consumer delete by id without depending on the file format. The computed id
 * is placed last so an on-disk element carrying a stray `id` property cannot
 * shadow it.
 */
export function toListJson(path: string, read: ApprovalsFileRead): object {
  const taint = read.file.taint === undefined ? null : read.file.taint;
  const entries: readonly object[] = read.file.entries.map((entry: ApprovalEntry) => ({
    ...entry,
    id: approvalId(entry),
  }));
  return {
    path,
    state: read.state,
    taint,
    droppedMalformed: read.droppedMalformed,
    entries,
  };
}

/**
 * The maximum length of the `<preview>` in the `removed <id>  <stage>  <preview>`
 * line (US-005). The preview is the command's first line, so multi-line scripts
 * are truncated to keep the line single-line and copy-paste-able.
 */
const REMOVAL_PREVIEW_LIMIT = 80;

/** The single line a removal prints for one entry, per the US-005 interface. */
export function formatRemovedLine(entry: ApprovalEntry): string {
  const id = approvalId(entry);
  // The preview is the command's first line rendered as a single line, so a
  // trailing CR is dropped and any remaining control/escape sequences are
  // stripped before printing (SEC-09).
  const preview = stripControlChars((entry.command.split("\n", 1)[0] ?? "").replace(/\r$/, ""));
  return `removed ${id}  ${stripControlChars(entry.stage)}  ${preview.slice(0, REMOVAL_PREVIEW_LIMIT)}`;
}
