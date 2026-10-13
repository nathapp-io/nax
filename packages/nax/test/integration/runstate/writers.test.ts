import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import { type AdviceDecision, appendDecision } from "@/advisor";
import { buildStatusSnapshot, writeStatusFile } from "@/execution/status-file";
import { savePRD } from "@/prd";
import { RunStateKeeper, registerKeeper, unregisterKeeper } from "@/runstate/store";
import { newFeatureRecord } from "@/workflow/feature-record";
import { appendLedger, ensureLedger } from "@/workflow/ledger";
import { upsertFeatureRecord } from "@/workflow/result";

let dir: string;
let keeper: RunStateKeeper;
const fdir = () => join(dir, ".nax/features/f");

const decisionDraft: Omit<AdviceDecision, "id"> = {
  questionId: "Q",
  kind: "finish-judgment",
  chosenOptionId: "A",
  action: { type: "fix", instruction: "x" },
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "2026-10-10T00:00:00Z",
  model: "m",
  memoryMode: "stateless",
  auditRef: "a",
};

beforeEach(async () => {
  dir = makeTempDir();
  await mkdir(join(fdir(), "workflow/run-1"), { recursive: true });
  keeper = new RunStateKeeper("run-1", "f");
  registerKeeper(keeper);
});
afterEach(() => {
  unregisterKeeper(keeper);
  cleanupTempDir(dir);
});

async function expectKept(path: string): Promise<void> {
  expect(keeper.get(path)?.content).toBe(await Bun.file(path).text());
  expect(keeper.isInFlight(path)).toBe(false);
}

describe("run-state writers record what they write (#2497)", () => {
  test("savePRD", async () => {
    const path = join(fdir(), "prd.json");
    await savePRD(makePRD(), path);
    await expectKept(path);
  });

  test("writeStatusFile", async () => {
    const path = join(fdir(), "status.json");
    const status = buildStatusSnapshot({
      runId: "run-1",
      feature: "f",
      startedAt: "2026-10-13T00:00:00.000Z",
      runStatus: "running",
      dryRun: false,
      pid: process.pid,
      prd: makePRD(),
      totalCost: 0,
      costLimit: 5,
      currentStory: null,
      iterations: 0,
      startTimeMs: Date.now(),
    });
    await writeStatusFile(path, status);
    await expectKept(path);
  });

  test("workflow result.json", async () => {
    const runDir = join(fdir(), "workflow/run-1");
    await upsertFeatureRecord(
      runDir,
      { runId: "run-1", feature: "f" },
      newFeatureRecord({ now: "t", seed: null, minors: [] }),
    );
    await expectKept(join(runDir, "result.json"));
  });

  test("workflow ledger header and appends", async () => {
    const runDir = join(fdir(), "workflow/run-1");
    await ensureLedger(runDir, "run-1", "f");
    await appendLedger(runDir, "US-001", "note one", { mirror: false });
    await appendLedger(runDir, "US-001", "note two", { mirror: false });
    await expectKept(join(runDir, "ledger.md"));
  });

  test("advisor decisions.jsonl appends", async () => {
    await appendDecision(dir, "f", decisionDraft);
    await appendDecision(dir, "f", { ...decisionDraft, questionId: "Q2" });
    await expectKept(join(fdir(), "decisions.jsonl"));
  });
});
