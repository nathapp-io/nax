import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";
import {
  type ApprovalEntry,
  appendApproval,
  approvalId,
  findApproval,
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
