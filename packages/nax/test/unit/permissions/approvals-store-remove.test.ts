/**
 * US-002: locked, taint-preserving `removeApprovals`.
 *
 * Lives in the test file the spec's US-002 `Creates` list names. The helpers
 * are local to this file, matching the pattern the other approvals test files
 * use; the read-side store tests stay in `approvals-store.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import * as permissions from "@/permissions";
import {
  type ApprovalEntry,
  type ApprovalsFileRead,
  appendApproval,
  type RemovalDecision,
  type RemovalResult,
  readApprovals,
  readApprovalsFile,
} from "@/permissions";

const entry = (command: string, stage = "implementer") => ({
  stage,
  command,
  root: "/repo",
  origin: "escalate" as const,
  matchedRule: null,
  approvedAt: "2026-09-22T10:00:00.000Z",
  approvedBy: "telegram:123",
  naxCommit: "7b37dbf74",
});

const STORE_FILE = "approvals.json";

const TAINT = { since: "s", runId: "r", pid: 7 };

/** A fully-formed entry; `overrides` replace any single field. */
const makeEntry = (overrides: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  ...entry("bun run test"),
  ...overrides,
});

/** Write raw bytes to a store file inside `dir`; returns the file path. */
function writeStore(dir: string, contents: string): string {
  const path = join(dir, STORE_FILE);
  writeFileSync(path, contents);
  return path;
}

/**
 * `removeApprovals` is reached through the module namespace instead of a named
 * import: a named import of an export that does not exist yet is a LINK error,
 * which fails every test in this file. A missing implementation therefore
 * surfaces as an ordinary assertion failure here, then the helper is a plain
 * call.
 */
async function removeApprovals(
  path: string,
  decide: (read: ApprovalsFileRead) => RemovalDecision,
): Promise<RemovalResult> {
  const fn = permissions.removeApprovals;
  expect(typeof fn).toBe("function");
  return fn(path, decide);
}

/** Narrow a `RemovalResult` to its `removed` arm, failing the test on the others. */
function removedArm(result: RemovalResult): Extract<RemovalResult, { outcome: "removed" }> {
  if (result.outcome !== "removed") {
    throw new Error(`[test] expected a "removed" outcome, got "${result.outcome}"`);
  }
  return result;
}

/** Three entries differing only in `command`, so each has its own id. */
const threeEntries = (): readonly ApprovalEntry[] => [
  makeEntry({ command: "cmd-a" }),
  makeEntry({ command: "cmd-b" }),
  makeEntry({ command: "cmd-c" }),
];

/** A decision selecting exactly the entry whose command is `command`. */
const selectCommand = (command: string): RemovalDecision => ({
  remove: (entry: ApprovalEntry) => entry.command === command,
});

const readBytes = (path: string): string => readFileSync(path, "utf8");

describe("removeApprovals", () => {
  test("US-002 AC1: a path with no file resolves to unchanged", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, STORE_FILE);
      expect(await removeApprovals(path, () => selectCommand("cmd-a"))).toEqual({ outcome: "unchanged" });
    });
  });

  test("US-002 AC2: a path with no file is not created", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, STORE_FILE);
      await removeApprovals(path, () => selectCommand("cmd-a"));
      expect(existsSync(path)).toBe(false);
    });
  });

  test("US-002 rule 4: a missing parent directory is neither created nor read as an error", async () => {
    await withTempDir(async (dir) => {
      const parent = join(dir, "nested", "project");
      const path = join(parent, STORE_FILE);
      const reads: ApprovalsFileRead[] = [];
      const result = await removeApprovals(path, (read) => {
        reads.push(read);
        return selectCommand("cmd-a");
      });
      expect(result).toEqual({ outcome: "unchanged" });
      expect(reads).toHaveLength(1);
      expect(reads[0]?.state).toBe("missing");
      expect(existsSync(parent)).toBe(false);
    });
  });

  test("US-002 AC3: a path with no file invokes decide once with a missing read", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, STORE_FILE);
      const reads: ApprovalsFileRead[] = [];
      await removeApprovals(path, (read) => {
        reads.push(read);
        return selectCommand("cmd-a");
      });
      expect(reads).toHaveLength(1);
      expect(reads[0]?.state).toBe("missing");
    });
  });

  test("US-002 AC4: an unparseable file is refused with the parse reason", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, "{ this is not json");
      expect(await removeApprovals(path, () => selectCommand("cmd-a"))).toEqual({
        outcome: "refused",
        reason: "approvals.json could not be parsed; not rewriting it",
      });
    });
  });

  test("US-002 AC4: a store whose top-level JSON is an array is refused too", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify(threeEntries()));
      expect(await removeApprovals(path, () => selectCommand("cmd-a"))).toEqual({
        outcome: "refused",
        reason: "approvals.json could not be parsed; not rewriting it",
      });
    });
  });

  test("US-002 AC5: an unparseable file's bytes are untouched", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, "{ this is not json");
      const before = readBytes(path);
      await removeApprovals(path, () => selectCommand("cmd-a"));
      expect(readBytes(path)).toBe(before);
    });
  });

  test("US-002 AC5: an unparseable file that carries a taint is not rewritten", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: "bun run test", taint: TAINT }));
      const before = readBytes(path);
      await removeApprovals(path, () => selectCommand("cmd-a"));
      expect(readBytes(path)).toBe(before);
    });
  });

  test("US-002 AC6: an unparseable file never reaches decide", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, "{ this is not json");
      let calls = 0;
      await removeApprovals(path, () => {
        calls += 1;
        return selectCommand("cmd-a");
      });
      expect(calls).toBe(0);
    });
  });

  test("US-002 AC7: a refuse decision resolves to that refusal reason", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: [makeEntry({ command: "cmd-a" })] }));
      const result = await removeApprovals(path, () => ({ refuse: "Unknown id(s): deadbeef" }));
      expect(result).toEqual({ outcome: "refused", reason: "Unknown id(s): deadbeef" });
    });
  });

  test("US-002 AC8: a refusal leaves the file's bytes untouched", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: threeEntries() }));
      const before = readBytes(path);
      await removeApprovals(path, () => ({ refuse: "Unknown id(s): deadbeef" }));
      expect(readBytes(path)).toBe(before);
    });
  });

  test("US-002 AC9: a predicate that selects no entry resolves to unchanged", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: threeEntries() }));
      expect(await removeApprovals(path, () => selectCommand("cmd-absent"))).toEqual({ outcome: "unchanged" });
    });
  });

  test("US-002 AC10: a predicate that selects no entry leaves the bytes untouched", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: threeEntries() }));
      const before = readBytes(path);
      await removeApprovals(path, () => ({ remove: () => false }));
      expect(readBytes(path)).toBe(before);
    });
  });

  test("US-002 AC11: a predicate selecting one of three entries reports exactly that entry as removed", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: threeEntries() }));
      const result = await removeApprovals(path, () => selectCommand("cmd-b"));
      expect(removedArm(result).removed).toEqual([makeEntry({ command: "cmd-b" })]);
    });
  });

  test("US-002 AC12: the two unselected entries are all that remain", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: threeEntries() }));
      await removeApprovals(path, () => selectCommand("cmd-b"));
      expect(await readApprovals(path)).toEqual([makeEntry({ command: "cmd-a" }), makeEntry({ command: "cmd-c" })]);
    });
  });

  test("US-002 AC13: a tainted store keeps its taint across a removal", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ taint: TAINT, entries: threeEntries() }));
      const before = (await readApprovalsFile(path)).taint;
      expect(before).toEqual(TAINT);
      await removeApprovals(path, () => selectCommand("cmd-a"));
      expect((await readApprovals(path)).map((entry) => entry.command)).toEqual(["cmd-b", "cmd-c"]);
      expect((await readApprovalsFile(path)).taint).toEqual(before);
    });
  });

  test("US-002 AC14: an untainted store gains no taint from a removal", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: threeEntries() }));
      await removeApprovals(path, () => selectCommand("cmd-a"));
      expect((await readApprovals(path)).map((entry) => entry.command)).toEqual(["cmd-b", "cmd-c"]);
      expect((await readApprovalsFile(path)).taint).toBeUndefined();
    });
  });

  test("US-002 AC15: one malformed element is reported as dropped when an entry is removed", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(
        dir,
        JSON.stringify({ entries: [makeEntry({ command: "cmd-a" }), null, makeEntry({ command: "cmd-b" })] }),
      );
      const result = await removeApprovals(path, () => selectCommand("cmd-a"));
      expect(removedArm(result).droppedMalformed).toBe(1);
    });
  });

  test("US-002 AC16: a removal racing an append leaves the appended entry alone", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: [makeEntry({ command: "cmd-a" })] }));
      const appended = makeEntry({ command: "cmd-b" });
      await Promise.all([removeApprovals(path, () => selectCommand("cmd-a")), appendApproval(path, appended)]);
      expect(await readApprovals(path)).toEqual([appended]);
    });
  });
});
