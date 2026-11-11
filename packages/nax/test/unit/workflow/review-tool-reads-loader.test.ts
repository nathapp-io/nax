/**
 * US-006 — loading a review session's persisted tool calls.
 *
 * The loader reads what the dispatch wrote: the same directory (`toolAuditDir`)
 * and the same ledger session name (`buildLedgerSessionName`), matched on the
 * file name `<runId>-<stamp>-<ledgerSessionName>.json`. These tests therefore
 * build REAL files in a temp dir instead of stubbing the file system — the name
 * and stamp matching is the behaviour under test, and a stubbed glob would let
 * it pass while scanning the wrong directory.
 *
 * Only the logger is overridden, so the warn a skipped file emits can be read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ToolCallRecord } from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { _reviewToolReadsDeps, readSessionToolCalls } from "@/workflow/review-tool-reads";

const AT = "2026-01-01T00:00:00.000Z";
const RUN_ID = "r1";
const SESSION = "f-wf-branch-review";

const logger = makeLogger();
let savedLogger: typeof _reviewToolReadsDeps.logger;
let dir: string;

beforeEach(() => {
  dir = makeTempDir("nax-review-tool-reads-");
  logger.reset();
  savedLogger = _reviewToolReadsDeps.logger;
  _reviewToolReadsDeps.logger = () => logger;
});

afterEach(() => {
  _reviewToolReadsDeps.logger = savedLogger;
  cleanupTempDir(dir);
});

/** The warn rows the loader emitted. */
function warns() {
  return logger.calls.filter((entry) => entry.level === "warn");
}

function call(path: string): ToolCallRecord {
  return { tool: "Read", outcome: "ok", input: { path }, resultBytes: 120, at: AT, truncated: false };
}

/** A tool-audit file named the way `createToolAuditSink` names it. */
async function writeAudit(name: string, calls: readonly ToolCallRecord[]): Promise<void> {
  await Bun.write(join(dir, name), JSON.stringify({ schemaVersion: 1, sessionName: SESSION, calls }));
}

/** A tool-audit file holding exactly `body`, for the shapes that are not valid. */
async function writeRaw(name: string, body: string): Promise<void> {
  await Bun.write(join(dir, name), body);
}

/** The loader over the temp dir, with the scope every AC names. */
function load(overrides: Partial<Parameters<typeof readSessionToolCalls>[0]> = {}) {
  return readSessionToolCalls({
    auditDir: dir,
    runId: RUN_ID,
    ledgerSessionName: SESSION,
    sinceMs: 1000,
    ...overrides,
  });
}

describe("readSessionToolCalls", () => {
  test("returns the calls of this run's and this session's file (AC-1)", async () => {
    await writeAudit("r1-2000-f-wf-branch-review.json", [call("src/a.ts"), call("src/b.ts")]);

    expect(await load()).toEqual([call("src/a.ts"), call("src/b.ts")]);
  });

  test("skips a file stamped below sinceMs (AC-2)", async () => {
    await writeAudit("r1-999-f-wf-branch-review.json", [call("src/a.ts")]);

    expect(await load()).toEqual([]);
  });

  test("keeps a file stamped exactly at sinceMs — the boundary is inclusive", async () => {
    await writeAudit("r1-1000-f-wf-branch-review.json", [call("src/a.ts")]);

    expect(await load()).toEqual([call("src/a.ts")]);
  });

  test("skips a file for another runId or another session name (AC-3)", async () => {
    await writeAudit("r2-2000-f-wf-branch-review.json", [call("src/other-run.ts")]);
    await writeAudit("r1-2000-other-session.json", [call("src/other-session.ts")]);

    expect(await load()).toEqual([]);
  });

  test("returns [] for a directory that does not exist (AC-4)", async () => {
    expect(await load({ auditDir: join(dir, "missing") })).toEqual([]);
  });

  test("skips a file holding not-json, keeps the others, and warns once (AC-5)", async () => {
    await writeRaw("r1-2000-f-wf-branch-review.json", "not json");
    await writeAudit("r1-1500-f-wf-branch-review.json", [call("src/a.ts")]);

    expect(await load()).toEqual([call("src/a.ts")]);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.data?.file).toBe("r1-2000-f-wf-branch-review.json");
  });

  test("returns the calls of the lower stamp first (AC-6)", async () => {
    await writeAudit("r1-2000-f-wf-branch-review.json", [call("src/b.ts")]);
    await writeAudit("r1-900-f-wf-branch-review.json", [call("src/a.ts")]);

    expect(await load({ sinceMs: 0 })).toEqual([call("src/a.ts"), call("src/b.ts")]);
  });

  test("skips a file with no calls array, with a warn, and keeps the others (AC-7)", async () => {
    await writeRaw("r1-2000-f-wf-branch-review.json", JSON.stringify({ schemaVersion: 1 }));
    await writeAudit("r1-1500-f-wf-branch-review.json", [call("src/a.ts")]);

    expect(await load()).toEqual([call("src/a.ts")]);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.data?.file).toBe("r1-2000-f-wf-branch-review.json");
  });
});
