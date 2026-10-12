import { afterEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { collectLedgerItems } from "@/workflow/ledger-items";
import { newStoryRecord, upsertStoryRecord } from "@/workflow/result";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function run(feature: string, name: string, secs: number, ledger: string): Promise<void> {
  const runDir = join(feature, name);
  await upsertStoryRecord(runDir, { runId: name, feature: "f" }, newStoryRecord("US-001", 5, "t"));
  await utimes(join(runDir, "result.json"), secs, secs);
  await Bun.write(join(runDir, "ledger.md"), ledger);
}

describe("collectLedgerItems", () => {
  test("deferred minors, cannot-verify items and parked rulings, oldest run first, deduped", async () => {
    const feature = makeTempDir("wf-li-");
    dirs.push(feature);
    await run(
      feature,
      "run-1",
      100,
      [
        "# Workflow ledger — run: run-1 — feature: f",
        "US-001: deferred-minor: rename tmp",
        "US-001: cannot-verify: Redis TTL",
        "US-001: Ruling: hold F2: flaky timer — deterministic default — stays open",
        "US-002: Ruling: pre-flight D-1: supersede US-2 AC-3 — spec newer — high confidence; reversible",
        "_run: Ruling: hold B1: drift — x — y",
        "US-001: fix round 1/5 (1 open: F1)",
      ].join("\n"),
    );
    await run(feature, "run-2", 200, "US-001: deferred-minor: rename tmp\nUS-003: deferred-minor: add doc comment\n");
    expect(await collectLedgerItems(feature)).toEqual({
      deferredMinors: [
        { storyId: "US-001", text: "rename tmp" },
        { storyId: "US-003", text: "add doc comment" },
      ],
      cannotVerify: [{ storyId: "US-001", text: "Redis TTL" }],
      parked: [{ storyId: "US-001", text: "hold F2: flaky timer — deterministic default — stays open" }],
    });
  });

  test("no run dirs -> empty lists", async () => {
    expect(await collectLedgerItems("/nonexistent/wf")).toEqual({ deferredMinors: [], cannotVerify: [], parked: [] });
  });
});
