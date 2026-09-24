import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";
import * as permissions from "@/permissions";
import {
  type ApprovalEntry,
  type ApprovalsFileRead,
  appendApproval,
  approvalId,
  findApproval,
  type RemovalDecision,
  type RemovalResult,
  readApprovals,
  readApprovalsFile,
  readApprovalsFileDetailed,
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

describe("approvals store", () => {
  test("a missing file reads as empty, not an error", async () => {
    const dir = makeTempDir("approvals-");
    expect(await readApprovals(join(dir, "approvals.json"))).toEqual([]);
    cleanupTempDir(dir);
  });

  test("a malformed file reads as empty rather than throwing", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    writeFileSync(path, "{ this is not json");
    expect(await readApprovals(path)).toEqual([]);
    cleanupTempDir(dir);
  });

  test("append then read round-trips", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await appendApproval(path, entry("bun run test"));
    const entries = await readApprovals(path);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.command).toBe("bun run test");
  });

  test("lookup is BYTE-EXACT: a prefix does not match a longer command", () => {
    const entries = [entry("bun run test")];
    expect(findApproval(entries, "implementer", "bun run test")).toBeDefined();
    expect(findApproval(entries, "implementer", "bun run test --reporter=./x")).toBeUndefined();
    expect(findApproval(entries, "implementer", "bun run test ")).toBeUndefined();
    expect(findApproval(entries, "implementer", "bun  run test")).toBeUndefined();
  });

  test.each([
    { projectRoot: "/repo", expected: true },
    { projectRoot: "/", expected: true },
    { projectRoot: "/repo/pkg", expected: false },
    { projectRoot: "/repo2", expected: false },
  ])("with projectRoot=$projectRoot an entry rooted at /repo matches=$expected", ({ projectRoot, expected }) => {
    const hit = findApproval([entry("bun run test")], "implementer", "bun run test", projectRoot);
    expect(hit !== undefined).toBe(expected);
  });

  test("an entry with no usable root never matches a root-scoped lookup", () => {
    const rootless = { ...entry("bun run test"), root: "" };
    expect(findApproval([rootless], "implementer", "bun run test", "/repo")).toBeUndefined();
    expect(findApproval([rootless], "implementer", "bun run test")).toBeDefined();
  });

  test("lookup is stage-scoped", () => {
    const entries = [entry("bun run test", "implementer")];
    expect(findApproval(entries, "verifier", "bun run test")).toBeUndefined();
  });

  test("a null element is dropped so a valid sibling still resolves without throwing", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    writeFileSync(path, JSON.stringify({ entries: [null, entry("bun run test")] }));
    const entries = await readApprovals(path);
    expect(entries).toHaveLength(1);
    expect(findApproval(entries, "implementer", "bun run test")).toBeDefined();
    cleanupTempDir(dir);
  });

  test("concurrent appends keep both entries and valid JSON", async () => {
    const dir = makeTempDir("approvals-");
    const path = join(dir, "approvals.json");
    await Promise.all([appendApproval(path, entry("cmd-a")), appendApproval(path, entry("cmd-b"))]);
    const commands = (await readApprovals(path)).map((e) => e.command).sort();
    expect(commands).toEqual(["cmd-a", "cmd-b"]);
  });
});

// --- US-001: derived approval ids and the detailed read --------------------

const STORE_FILE = "approvals.json";

const TAINT = { since: "s", runId: "r", pid: 7 };

/** A fully-formed entry; `overrides` replace any single field. */
const makeEntry = (overrides: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  ...entry("bun run test"),
  ...overrides,
});

/**
 * Independent implementation of the documented id formula. Written with
 * node:crypto rather than the Bun hasher the implementation is expected to use,
 * so the test does not merely restate the code under test.
 */
const digest8 = (stage: string, command: string, approvedAt: string): string =>
  createHash("sha256").update(`${stage}\0${command}\0${approvedAt}`).digest("hex").slice(0, 8);

/** Write raw bytes to a store file inside `dir`; returns the file path. */
function writeStore(dir: string, contents: string): string {
  const path = join(dir, STORE_FILE);
  writeFileSync(path, contents);
  return path;
}

describe("approvalId", () => {
  test("AC1: returns exactly 8 lowercase hexadecimal characters", () => {
    expect(approvalId(makeEntry())).toMatch(/^[0-9a-f]{8}$/);
  });

  test("AC2: two entries with the same stage, command and approvedAt share an id", () => {
    const first = makeEntry({ root: "/repo", approvedBy: "telegram:123" });
    const second = makeEntry({ root: "/repo/.nax-wt/US-002", approvedBy: "slack:9", naxCommit: "deadbeef" });
    expect(approvalId(second)).toBe(approvalId(first));
  });

  test("AC3: the same stage and command approved at different times get different ids", () => {
    const first = makeEntry({ approvedAt: "2026-09-22T10:00:00.000Z" });
    const second = makeEntry({ approvedAt: "2026-09-22T11:00:00.000Z" });
    expect(approvalId(second)).not.toBe(approvalId(first));
  });

  test("AC4: equals the first 8 hex characters of sha256(stage NUL command NUL approvedAt)", () => {
    const e = makeEntry({
      stage: "execution",
      command: "cat <<'EOF' > notes.txt",
      approvedAt: "2026-09-22T10:14:03.000Z",
    });
    expect(approvalId(e)).toBe(digest8(e.stage, e.command, e.approvedAt));
  });

  test("AC5: a missing approvedAt is hashed as an empty string", () => {
    const { approvedAt: _omitted, ...withoutApprovedAt } = makeEntry();
    expect(approvalId(withoutApprovedAt as ApprovalEntry)).toBe(digest8("implementer", "bun run test", ""));
  });

  test("US-001: an approvedAt that is not a string is hashed as an empty string", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: [{ ...makeEntry(), approvedAt: 7 }] }));
      const stored: ApprovalEntry | undefined = (await readApprovalsFileDetailed(path)).file.entries[0];
      assertDefined(stored, "stored entry");
      expect(approvalId(stored)).toBe(digest8("implementer", "bun run test", ""));
    });
  });
});

describe("readApprovalsFileDetailed", () => {
  test("AC6: a path with no file reads as missing with an empty file", async () => {
    await withTempDir(async (dir) => {
      expect(await readApprovalsFileDetailed(join(dir, STORE_FILE))).toEqual({
        state: "missing",
        file: { entries: [], taint: undefined },
        droppedMalformed: 0,
      });
    });
  });

  test("US-001: a path whose parent directory does not exist also reads as missing", async () => {
    await withTempDir(async (dir) => {
      expect((await readApprovalsFileDetailed(join(dir, "absent", STORE_FILE))).state).toBe("missing");
    });
  });

  test("AC7: a file that is not valid JSON reads as unparseable", async () => {
    await withTempDir(async (dir) => {
      expect((await readApprovalsFileDetailed(writeStore(dir, "{ this is not json"))).state).toBe("unparseable");
    });
  });

  test("AC8: a file whose top-level JSON value is an array reads as unparseable", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify([makeEntry()]));
      expect((await readApprovalsFileDetailed(path)).state).toBe("unparseable");
    });
  });

  test("US-001: a file whose top-level JSON value is null reads as unparseable", async () => {
    await withTempDir(async (dir) => {
      expect((await readApprovalsFileDetailed(writeStore(dir, "null"))).state).toBe("unparseable");
    });
  });

  test("AC9: a file whose entries value is a string reads as unparseable", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: "bun run test" }));
      expect((await readApprovalsFileDetailed(path)).state).toBe("unparseable");
    });
  });

  test("AC10: a file that is not valid JSON yields an empty file", async () => {
    await withTempDir(async (dir) => {
      expect((await readApprovalsFileDetailed(writeStore(dir, "{ this is not json"))).file).toEqual({
        entries: [],
        taint: undefined,
      });
    });
  });

  test("US-001: an unparseable file reports no dropped elements", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, "{ this is not json");
      expect((await readApprovalsFileDetailed(path)).droppedMalformed).toBe(0);
    });
  });

  test("AC11: two valid entries beside a null element read as ok", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(
        dir,
        JSON.stringify({ entries: [makeEntry({ command: "cmd-a" }), null, makeEntry({ command: "cmd-b" })] }),
      );
      expect((await readApprovalsFileDetailed(path)).state).toBe("ok");
    });
  });

  test("AC12: two valid entries beside a null element keep exactly those two entries", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(
        dir,
        JSON.stringify({ entries: [makeEntry({ command: "cmd-a" }), null, makeEntry({ command: "cmd-b" })] }),
      );
      expect((await readApprovalsFileDetailed(path)).file.entries).toEqual([
        makeEntry({ command: "cmd-a" }),
        makeEntry({ command: "cmd-b" }),
      ]);
    });
  });

  test("AC13: two valid entries beside a null element report one dropped element", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(
        dir,
        JSON.stringify({ entries: [makeEntry({ command: "cmd-a" }), null, makeEntry({ command: "cmd-b" })] }),
      );
      expect((await readApprovalsFileDetailed(path)).droppedMalformed).toBe(1);
    });
  });

  test("AC14: a taint record is parsed onto the file", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: [], taint: TAINT }));
      expect((await readApprovalsFileDetailed(path)).file.taint).toEqual(TAINT);
    });
  });

  test("US-001: an object with no entries key reads as ok and empty", async () => {
    await withTempDir(async (dir) => {
      expect(await readApprovalsFileDetailed(writeStore(dir, "{}"))).toEqual({
        state: "ok",
        file: { entries: [], taint: undefined },
        droppedMalformed: 0,
      });
    });
  });

  test("AC17: a present taint survives beside an entries value that is a string", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: "bun run test", taint: TAINT }));
      expect((await readApprovalsFileDetailed(path)).file.taint).toEqual(TAINT);
    });
  });
});

describe("readApprovalsFile", () => {
  test("AC15: a valid tainted file returns exactly the detailed read's file", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ taint: TAINT, entries: [makeEntry()] }));
      expect(await readApprovalsFile(path)).toEqual((await readApprovalsFileDetailed(path)).file);
    });
  });

  test("AC15: a valid tainted file keeps its entry and its taint", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ taint: TAINT, entries: [makeEntry()] }));
      expect(await readApprovalsFile(path)).toEqual({ entries: [makeEntry()], taint: TAINT });
    });
  });

  test("AC16: a file whose entries value is a string returns an empty entries array", async () => {
    await withTempDir(async (dir) => {
      const path = writeStore(dir, JSON.stringify({ entries: "bun run test" }));
      expect((await readApprovalsFile(path)).entries).toEqual([]);
    });
  });
});

// --- US-002: locked, taint-preserving store removal -------------------------

/**
 * `removeApprovals` is reached through the module namespace instead of a named
 * import: a named import of an export that does not exist yet is a LINK error,
 * which fails every test in this file -- the read-side tests above have nothing
 * to do with this story. A missing implementation therefore surfaces as an
 * ordinary assertion failure here, then the helper is a plain call.
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
