/**
 * US-004: the handed-off mark is a sidecar beside the newest run's `result.json`, so it never changes
 * the record koda receives and it disappears from the newest run as soon as a later run writes its own
 * record. These cases cover the writer, the newest-run reader and the one sentence every refusal uses.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import {
  HANDOFF_MARK_FILE,
  type HandoffMark,
  handoffMarkRefusal,
  readNewestHandoffMark,
  writeHandoffMark,
} from "@/workflow/handoff-mark";

const RESULT = '{"schemaVersion":1,"runId":"{run}","stories":{}}\n';

/**
 * A run directory holding a `result.json` (the newest-run ordering reads its mtime) and, when given,
 * an `at`-shaped handoff mark written as raw text so a fixture can be deliberately malformed.
 */
async function makeRun(
  workflowDir: string,
  runId: string,
  fixture: { readonly resultMtimeMs: number; readonly mark?: string },
): Promise<string> {
  const runDir = join(workflowDir, runId);
  await mkdir(runDir, { recursive: true });
  const resultPath = join(runDir, "result.json");
  await Bun.write(resultPath, RESULT.replace("{run}", runId));
  await utimes(resultPath, fixture.resultMtimeMs / 1000, fixture.resultMtimeMs / 1000);
  if (fixture.mark !== undefined) await Bun.write(join(runDir, HANDOFF_MARK_FILE), fixture.mark);
  return runDir;
}

const FLOW_MARK: HandoffMark = {
  schemaVersion: 1,
  at: "2026-11-18T00:00:00.000Z",
  flowId: "fl1",
  url: "https://koda/flows/fl1",
};

describe("writeHandoffMark (US-004)", () => {
  test("AC-1 writes handoff.json beside result.json and reads back the same mark", async () => {
    await withTempDir(async (dir) => {
      await writeHandoffMark(dir, FLOW_MARK);
      expect(await Bun.file(join(dir, HANDOFF_MARK_FILE)).json()).toEqual(FLOW_MARK);
    });
  });

  test("AC-2 leaves the mtime of result.json unchanged", async () => {
    await withTempDir(async (dir) => {
      const resultPath = join(dir, "result.json");
      await Bun.write(resultPath, RESULT.replace("{run}", "r1"));
      const before = 1_700_000_000; // a fixture time, so a rewrite of the record is visible
      await utimes(resultPath, before, before);
      await writeHandoffMark(dir, FLOW_MARK);
      expect((await stat(resultPath)).mtimeMs).toBe(before * 1000);
    });
  });
});

describe("readNewestHandoffMark (US-004)", () => {
  test("AC-3 returns the mark of the run with the newest result.json and its path", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r-old", { resultMtimeMs: 1_000, mark: JSON.stringify(FLOW_MARK) });
      const newest = await makeRun(dir, "r-new", { resultMtimeMs: 2_000, mark: JSON.stringify(FLOW_MARK) });
      expect(await readNewestHandoffMark(dir)).toEqual({
        mark: FLOW_MARK,
        path: join(newest, HANDOFF_MARK_FILE),
      });
    });
  });

  test("AC-4 returns null when only an older run holds a mark", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r-old", { resultMtimeMs: 1_000, mark: JSON.stringify(FLOW_MARK) });
      await makeRun(dir, "r-new", { resultMtimeMs: 2_000 });
      expect(await readNewestHandoffMark(dir)).toBeNull();
    });
  });

  test("AC-5 returns null when the newest run's handoff.json is not JSON", async () => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r-new", { resultMtimeMs: 2_000, mark: "not json" });
      expect(await readNewestHandoffMark(dir)).toBeNull();
    });
  });

  test.each([
    ["an object with no schema version", '{"flowId":"fl1"}'],
    ["a mark whose flowId is not a name", '{"schemaVersion":1,"at":"T","flowId":5}'],
  ])("returns null when the newest run's handoff.json is %s", async (_case, mark) => {
    await withTempDir(async (dir) => {
      await makeRun(dir, "r-new", { resultMtimeMs: 2_000, mark });
      expect(await readNewestHandoffMark(dir)).toBeNull();
    });
  });

  test("AC-6 returns null for a workflow dir that does not exist", async () => {
    await withTempDir(async (dir) => {
      expect(await readNewestHandoffMark(join(dir, "missing"))).toBeNull();
    });
  });
});

describe("handoffMarkRefusal (US-004)", () => {
  test("AC-7 names the flow, the mark's time, and the file to delete", () => {
    expect(handoffMarkRefusal("f1", { mark: { ...FLOW_MARK, at: "T" }, path: "/r/handoff.json" })).toBe(
      "f1 was handed off to koda (flow fl1 https://koda/flows/fl1) at T; koda publishes it. Delete /r/handoff.json to publish it here instead",
    );
  });

  test("AC-8 names the approval request in place of the flow", () => {
    const refused = handoffMarkRefusal("f1", {
      mark: { schemaVersion: 1, at: "T", requestId: "rq1" },
      path: "/r/handoff.json",
    });
    expect(refused).toContain("(approval request rq1)");
    expect(refused).not.toContain("flow ");
  });

  test("AC-13 names an unknown outcome when the mark has neither a flow nor a request", () => {
    expect(
      handoffMarkRefusal("f1", { mark: { schemaVersion: 1, at: "T", outcomeUnknown: true }, path: "/r/handoff.json" }),
    ).toContain("(outcome unknown; check koda's flows first)");
  });
});
