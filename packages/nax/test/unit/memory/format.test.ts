/**
 * US-015 — the shared memory formatters.
 *
 * The three functions are the only place a memory fact becomes text: `/memory` and the
 * `nax memory` group both print what they return, so the line shapes and the rule that an
 * absent value drops its line (or prints `never`) are pinned here rather than at a surface.
 */

import { describe, expect, test } from "bun:test";
import type { MemoryNote, MemorySyncResult } from "@nathapp/nax-agent";
import { formatMemoryNoteLine, formatMemoryStatus, formatMemorySyncResult, type MemoryStatus } from "@/memory";

/** A status as the host reports one: every count set, so no line is dropped by accident. */
const STATUS: MemoryStatus = {
  enabled: true,
  provider: "local",
  writeMode: "direct",
  projectDir: "/home/u/.nax/memory/projects/nax-monorepo-1a2b3c4d",
  userDir: "/home/u/.nax/memory/user",
  lastPullAt: "2026-11-02T08:11:00.000Z",
  lastError: null,
  queued: 0,
  rejected: 0,
  rejectedEntries: [],
  notes: { project: 3, user: 1, repo: 2 },
  repoSkipped: 0,
};

/** One sync result, filled in; `outcome` is the field each case varies. */
const SYNCED: MemorySyncResult = { outcome: "synced", pushed: 1, rejected: 0, pulled: 0, skipped: 0 };

/** The note `nax memory list` prints a row for: a project note with every field set. */
const NOTE: MemoryNote = {
  id: "nax-chat",
  slug: "staging-db",
  type: "project",
  scope: "project",
  description: "shared staging db",
  source: "repo",
  updatedAt: "2026-11-02T08:11:00.000Z",
  status: "active",
  body: "The staging database is shared with the review environment.",
};

describe("formatMemoryStatus", () => {
  test("AC-13 a never-pulled mirror reports last sync: never", () => {
    const lines = formatMemoryStatus({ ...STATUS, lastPullAt: null }).split("\n");
    expect(lines).toContain("last sync: never");
  });

  test("a koda-linked status says koda decides the write mode instead of naming a local one", () => {
    const lines = formatMemoryStatus({ ...STATUS, writeMode: "koda" }).split("\n");
    expect(lines).toContain("write mode: decided by koda");
  });

  test("AC-14 a clean last sync prints no last error line", () => {
    const lines = formatMemoryStatus({ ...STATUS, lastError: null }).split("\n");
    expect(lines.filter((line) => line.startsWith("last error:"))).toEqual([]);
  });

  test("names each rejected entry after the outbox counts", () => {
    const lines = formatMemoryStatus({
      ...STATUS,
      rejected: 1,
      rejectedEntries: [{ kind: "forget", scope: "project", slug: "gone", reason: "parked after 3 bad responses: x" }],
    }).split("\n");
    const outbox = lines.indexOf("outbox: 0 queued, 1 rejected");
    expect(lines[outbox + 1]).toBe("rejected: forget project/gone (parked after 3 bad responses: x)");
  });

  test("AC-15 reports the outbox counts", () => {
    const lines = formatMemoryStatus({ ...STATUS, queued: 2, rejected: 1 }).split("\n");
    expect(lines).toContain("outbox: 2 queued, 1 rejected");
  });

  test("AC-16 a nonzero skip count reports how many repo notes were skipped", () => {
    const lines = formatMemoryStatus({ ...STATUS, repoSkipped: 1 }).split("\n");
    expect(lines).toContain("repo notes skipped: 1");
  });

  test("AC-17 without an index the block ends at the last status line", () => {
    const text = formatMemoryStatus(STATUS);
    expect(text.endsWith("notes: 3 project, 1 user, 2 repo")).toBe(true);
  });

  test("prints the status lines in their fixed order, then the index", () => {
    const text = formatMemoryStatus(
      { ...STATUS, lastError: "pull failed", repoSkipped: 1, queued: 2, rejected: 1 },
      "# Memory\n- [project] staging-db — shared staging db",
    );
    expect(text).toBe(
      [
        "provider: local",
        "write mode: direct",
        "mirror: /home/u/.nax/memory/projects/nax-monorepo-1a2b3c4d",
        "user notes: /home/u/.nax/memory/user",
        "last sync: 2026-11-02T08:11:00.000Z",
        "last error: pull failed",
        "outbox: 2 queued, 1 rejected",
        "notes: 3 project, 1 user, 2 repo",
        "repo notes skipped: 1",
        "",
        "# Memory",
        "- [project] staging-db — shared staging db",
      ].join("\n"),
    );
  });

  test("no repo note skipped means no skip line at all", () => {
    const lines = formatMemoryStatus(STATUS).split("\n");
    expect(lines.filter((line) => line.startsWith("repo notes skipped:"))).toEqual([]);
  });
});

describe("formatMemorySyncResult", () => {
  test("AC-11 an unreachable provider is reported without counts", () => {
    expect(formatMemorySyncResult({ ...SYNCED, outcome: "unreachable" })).toBe("memory sync: unreachable");
  });

  test("AC-12 a failed run names the failure", () => {
    const result: MemorySyncResult = { ...SYNCED, outcome: "failed", error: "lock busy" };
    expect(formatMemorySyncResult(result)).toBe("memory sync: failed: lock busy");
  });

  test("a synced run reports all four counts", () => {
    expect(formatMemorySyncResult(SYNCED)).toBe("memory sync: synced (pushed 1, rejected 0, pulled 0, skipped 0)");
  });

  test("a run that parked entries names each one on its own line", () => {
    const result: MemorySyncResult = {
      ...SYNCED,
      rejected: 1,
      parked: [
        { clientId: "c1", kind: "forget", scope: "project", slug: "gone", reason: "parked after 3 bad responses: x" },
      ],
    };
    expect(formatMemorySyncResult(result).split("\n")).toEqual([
      "memory sync: synced (pushed 1, rejected 1, pulled 0, skipped 0)",
      "memory sync: parked forget project/gone (parked after 3 bad responses: x)",
    ]);
  });

  test("a failed run still names what it parked", () => {
    const result: MemorySyncResult = {
      ...SYNCED,
      outcome: "failed",
      error: "pull failed",
      parked: [
        { clientId: "c1", kind: "save", scope: "user", slug: "tone", reason: "parked after 3 bad responses: y" },
      ],
    };
    expect(formatMemorySyncResult(result).split("\n")).toEqual([
      "memory sync: failed: pull failed",
      "memory sync: parked save user/tone (parked after 3 bad responses: y)",
    ]);
  });

  test("a locked mirror says so", () => {
    expect(formatMemorySyncResult({ ...SYNCED, outcome: "locked" })).toBe("memory sync: locked");
  });
});

describe("formatMemoryNoteLine", () => {
  test("AC-18 one note is scope, slug, type, description, status and source", () => {
    expect(formatMemoryNoteLine(NOTE)).toBe("project/staging-db [project] shared staging db (active; repo)");
  });

  test("a user note keeps its own scope", () => {
    expect(formatMemoryNoteLine({ ...NOTE, scope: "user", type: "user", source: "nax-chat" })).toBe(
      "user/staging-db [user] shared staging db (active; nax-chat)",
    );
  });
});

describe("@/memory exports", () => {
  test("AC-19 the three formatters are importable from the barrel", () => {
    expect([formatMemoryStatus, formatMemorySyncResult, formatMemoryNoteLine].map((fn) => typeof fn)).toEqual([
      "function",
      "function",
      "function",
    ]);
  });
});
