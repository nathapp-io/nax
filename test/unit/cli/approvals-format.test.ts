/**
 * Approvals CLI formatting (US-003)
 *
 * AC6/AC14-AC16: the trust line printed under `Approvals store: <path>`.
 * AC9-AC13:       the block printed for one remembered approval.
 *
 * `formatTrustLine` and `formatEntryBlock` are the pure helpers `nax approvals
 * list` renders through (src/cli/approvals-format.ts), so they are pinned here
 * byte-for-byte; test/unit/cli/approvals.test.ts pins the same shapes through
 * `approvalsListCommand`.
 */

import { describe, expect, test } from "bun:test";
import { formatEntryBlock, formatTrustLine } from "@/cli/approvals-format";
import { type ApprovalEntry, type ApprovalsTaint, approvalId } from "@/permissions";

/** The entry line, the root line and the first command line all start at 10. */
const ENTRY_INDENT = " ".repeat(10);
/** Second and later lines of a multi-line command are indented 12. */
const COMMAND_CONTINUATION_INDENT = " ".repeat(12);

const TAINT_SINCE = "2026-09-20T08:30:00.000Z";
const TAINT_RUN_ID = "run-7f3a";

function makeEntry(overrides: Partial<ApprovalEntry> = {}): ApprovalEntry {
  return {
    stage: "implementer",
    command: "bun run test",
    root: "/repo",
    origin: "escalate",
    matchedRule: null,
    approvedAt: "2026-09-22T10:00:00.000Z",
    approvedBy: "telegram:123",
    naxCommit: "7b37dbf74",
    ...overrides,
  };
}

describe("formatTrustLine", () => {
  test("AC6: returns 'Cache: trusted' when the store carries no taint", () => {
    expect(formatTrustLine(undefined, () => true)).toBe("Cache: trusted");
  });

  test("AC14: names the taint's since, runId and pid, and marks a live pid alive", () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: 4242 };

    expect(formatTrustLine(taint, () => true)).toBe(
      `Cache: TAINTED since ${TAINT_SINCE} by run ${TAINT_RUN_ID} (pid 4242, alive) -- the cache is OFF; a trusted run will discard these entries.`,
    );
  });

  test("AC15: marks the pid exited when the liveness check reports it dead", () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: 4242 };

    expect(formatTrustLine(taint, () => false)).toBe(
      `Cache: TAINTED since ${TAINT_SINCE} by run ${TAINT_RUN_ID} (pid 4242, exited) -- the cache is OFF; a trusted run will discard these entries.`,
    );
  });

  test("AC16: reports an unknown pid when the taint was written without one", () => {
    const taint: ApprovalsTaint = { since: TAINT_SINCE, runId: TAINT_RUN_ID, pid: undefined };

    expect(formatTrustLine(taint, () => true)).toBe(
      `Cache: TAINTED since ${TAINT_SINCE} by run ${TAINT_RUN_ID} (pid unknown) -- the cache is OFF; a trusted run will discard these entries.`,
    );
  });
});

describe("formatEntryBlock", () => {
  test("AC9: renders the entry line as '<id>  <stage>  <origin>  <approvedAt>  <approvedBy>  naxCommit <naxCommit>'", () => {
    const entry = makeEntry({
      stage: "verifier",
      command: "bun run verify",
      origin: "askRule",
      approvedAt: "2026-01-02T03:04:05.000Z",
      approvedBy: "console:alice",
      naxCommit: "abc1234",
    });

    expect(formatEntryBlock(entry)[0]).toBe(
      `${approvalId(entry)}  verifier  askRule  2026-01-02T03:04:05.000Z  console:alice  naxCommit abc1234`,
    );
  });

  test("AC10: renders the root line as 10 spaces followed by 'root <root>'", () => {
    const entry = makeEntry({ root: "/repo/worktree-3" });

    expect(formatEntryBlock(entry)[1]).toBe(`${ENTRY_INDENT}root /repo/worktree-3`);
  });

  test("AC11: renders a single-line command as 10 spaces followed by '$ <command>'", () => {
    const entry = makeEntry({ command: "bun run test" });

    expect(formatEntryBlock(entry)).toEqual([
      `${approvalId(entry)}  implementer  escalate  2026-09-22T10:00:00.000Z  telegram:123  naxCommit 7b37dbf74`,
      `${ENTRY_INDENT}root /repo`,
      `${ENTRY_INDENT}$ bun run test`,
    ]);
  });

  test("AC12: prefixes the second and later lines of a multi-line command with 12 spaces", () => {
    const entry = makeEntry({ command: "set -e\nbun run lint\nbun run build" });

    expect(formatEntryBlock(entry)).toEqual([
      `${approvalId(entry)}  implementer  escalate  2026-09-22T10:00:00.000Z  telegram:123  naxCommit 7b37dbf74`,
      `${ENTRY_INDENT}root /repo`,
      `${ENTRY_INDENT}$ set -e`,
      `${COMMAND_CONTINUATION_INDENT}bun run lint`,
      `${COMMAND_CONTINUATION_INDENT}bun run build`,
    ]);
  });

  test("AC13: renders a command containing API_KEY=abc123 unaltered", () => {
    const entry = makeEntry({ command: "export API_KEY=abc123 && bun run test" });

    expect(formatEntryBlock(entry)[2]).toBe(`${ENTRY_INDENT}$ export API_KEY=abc123 && bun run test`);
  });

  test("AC9 boundary: an entry with no approvedAt still renders its line, with an empty field", () => {
    const entry = makeEntry({ approvedAt: "" });

    expect(formatEntryBlock(entry)[0]).toBe(
      `${approvalId(entry)}  implementer  escalate    telegram:123  naxCommit 7b37dbf74`,
    );
  });
});
