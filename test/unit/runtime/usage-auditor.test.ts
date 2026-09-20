import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { getLogger, initLogger, resetLogger } from "@/logger";
import { _usageAuditorDeps, createNoOpUsageAuditor, type UsageAuditEntry, UsageAuditor } from "@/runtime/usage-auditor";

const RUN_ID = "r-001";

/** The persisted row adds the derived role to the entry the auditor accepts. */
interface UsageRow extends UsageAuditEntry {
  readonly sessionRole?: string;
}

function makeEntry(overrides: Partial<UsageAuditEntry> = {}): UsageAuditEntry {
  return {
    ts: 1_700_000_000_000,
    runId: RUN_ID,
    scopeId: "scope-1",
    streamCallId: "call-001",
    sessionName: "nax-abc-feat-US-001-implementer",
    storyId: "US-001",
    stage: "run",
    agentName: "claude",
    roundTrip: 37,
    cadence: "round-trip",
    input: 120,
    output: 45,
    cacheRead: 30,
    cacheWrite: 12,
    costUsd: 0.0042,
    ...overrides,
  };
}

function appendBuffer(): Map<string, string> {
  return new Map<string, string>();
}

function jsonlFor(files: Map<string, string>, dir: string): string {
  return files.get(join(dir, `${RUN_ID}.jsonl`)) ?? "";
}

function parseRows(jsonl: string): UsageRow[] {
  // JSON.parse is untyped; the return annotation is the only assertion and it
  // avoids adding a counted `as` cast to the escape-hatch ratchet.
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("UsageAuditor", () => {
  let files: Map<string, string>;
  let origAppend: typeof _usageAuditorDeps.appendLine;

  beforeEach(() => {
    files = appendBuffer();
    origAppend = _usageAuditorDeps.appendLine;
    _usageAuditorDeps.appendLine = async (path: string, data: string) => {
      files.set(path, (files.get(path) ?? "") + data);
    };
  });

  afterEach(() => {
    _usageAuditorDeps.appendLine = origAppend;
  });

  test("appends one line per entry without rewriting earlier lines", async () => {
    await withTempDir(async (dir) => {
      const aud = new UsageAuditor(RUN_ID, dir);
      aud.record(makeEntry({ streamCallId: "call-001" }));
      await aud.flush();
      const first = jsonlFor(files, dir);
      expect(parseRows(first)).toHaveLength(1);

      aud.record(makeEntry({ streamCallId: "call-002" }));
      await aud.flush();
      const after = jsonlFor(files, dir);

      // The file grew and the earlier bytes are untouched — an append, not a rewrite.
      expect(after.length).toBeGreaterThan(first.length);
      expect(after.startsWith(first)).toBe(true);
      const rows = parseRows(after);
      expect(rows).toHaveLength(2);
      expect(rows[0].streamCallId).toBe("call-001");
      expect(rows[1].streamCallId).toBe("call-002");
    });
  });

  test("writes the exact row shape keyed on streamCallId, never callId", async () => {
    await withTempDir(async (dir) => {
      const aud = new UsageAuditor(RUN_ID, dir);
      aud.record(makeEntry());
      await aud.flush();
      const [row] = parseRows(jsonlFor(files, dir));

      expect(Object.keys(row).sort()).toEqual(
        [
          "agentName",
          "cacheRead",
          "cacheWrite",
          "cadence",
          "costUsd",
          "input",
          "output",
          "roundTrip",
          "runId",
          "scopeId",
          "sessionName",
          "sessionRole",
          "stage",
          "storyId",
          "streamCallId",
          "ts",
        ].sort(),
      );
      // The stream-local UUID must never masquerade as the ledger's callId.
      expect(row.streamCallId).toBe("call-001");
      expect("callId" in row).toBe(false);
      expect(row).toMatchObject({
        ts: 1_700_000_000_000,
        runId: RUN_ID,
        scopeId: "scope-1",
        sessionName: "nax-abc-feat-US-001-implementer",
        storyId: "US-001",
        stage: "run",
        agentName: "claude",
        roundTrip: 37,
        cadence: "round-trip",
        input: 120,
        output: 45,
        cacheRead: 30,
        cacheWrite: 12,
        costUsd: 0.0042,
      });
    });
  });

  test.each([
    ["US-001-implementer", "implementer"],
    ["US-001-repo-scoped-test-fix", "repo-scoped-test-fix"],
    ["US-001-reviewer-semantic", "reviewer-semantic"],
    ["US-001-reviewer-adversarial", "reviewer-adversarial"],
    ["US-001-finish-review-quality", "finish-review-quality"],
    ["main", "main"],
  ] as const)("derives sessionRole from %s as longest trailing match %s", async (sessionName, expected) => {
    await withTempDir(async (dir) => {
      const aud = new UsageAuditor(RUN_ID, dir);
      aud.record(makeEntry({ sessionName }));
      await aud.flush();
      const [row] = parseRows(jsonlFor(files, dir));
      expect(row.sessionRole).toBe(expected);
    });
  });

  test.each([["US-001-frobnicate"], ["US-001-unrecognised-role"]])(
    "leaves sessionRole absent for unrecognised suffix %s",
    async (sessionName) => {
      await withTempDir(async (dir) => {
        const aud = new UsageAuditor(RUN_ID, dir);
        aud.record(makeEntry({ sessionName }));
        await aud.flush();
        const [row] = parseRows(jsonlFor(files, dir));
        // Never a free-form string — session-role.ts bans those.
        expect("sessionRole" in row).toBe(false);
      });
    },
  );

  test("keeps absent cache figures absent rather than coercing to zero", async () => {
    await withTempDir(async (dir) => {
      const aud = new UsageAuditor(RUN_ID, dir);
      aud.record(makeEntry({ cacheRead: undefined, cacheWrite: undefined }));
      await aud.flush();
      const [row] = parseRows(jsonlFor(files, dir));
      expect("cacheRead" in row).toBe(false);
      expect("cacheWrite" in row).toBe(false);
    });
  });

  test("a write failure logs a warning and does not throw", async () => {
    await withTempDir(async (dir) => {
      const logFile = join(dir, "nax.log.jsonl");
      initLogger({ level: "silent", filePath: logFile });
      try {
        _usageAuditorDeps.appendLine = async () => {
          throw new Error("disk full");
        };
        const aud = new UsageAuditor(RUN_ID, join(dir, "usage"));
        aud.record(makeEntry());
        await aud.flush();

        await getLogger().flush();
        const content = await Bun.file(logFile).text();
        expect(content).toContain("usage-audit write failed");
      } finally {
        resetLogger();
      }
    });
  });

  test("createNoOpUsageAuditor writes nothing", async () => {
    const aud = createNoOpUsageAuditor();
    aud.record(makeEntry());
    await aud.flush();
    expect(files.size).toBe(0);
  });
});
