/**
 * The finish machine, end to end over stubbed ops: the shapes a finish can end in (promoted, draft with
 * its reason, local-only) and the result file each leaves behind. The invariants for throws, aborts and
 * deadlines live in `machine-invariants.test.ts`; the fix/re-review loops in `machine-loops.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, makeMachineHarness, restoreFinishMachineStubs, withTempDir } from "@test/helpers";
import type { Finding, FinishReviewOutput } from "@/finish";
import { resultPath, runFinishMachine } from "@/finish";

afterEach(() => restoreFinishMachineStubs());

const finding = (title: string, extra: Partial<Finding> = {}): Finding => ({
  severity: "MEDIUM",
  title,
  problem: "p",
  fix: "f",
  source: "quality",
  file: "a.ts",
  ...extra,
});
const q = (title: string): FinishReviewOutput => ({ findings: [finding(title)], covered: ["a.ts"] });
const MISSING: FinishReviewOutput = { findings: [], covered: [], missing: true };

describe("machine-end-to-end", () => {
  test("clean run: acceptance green, reviews clean, gates green, promotePr, status promoted, outcome ready", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({ auditDir: dir });
      const result = await runFinishMachine(state, deps);

      expect(result.status).toBe("promoted");
      expect(result.outcome).toBe("ready");
      expect(result.reason).toBeUndefined();
      expect(result.facts?.acceptance).toBe("green");
      expect(trail).toEqual([
        "acceptance-run",
        "openDraftPr",
        "review:spec",
        "review:quality",
        "acceptance-run",
        "quality-run:test",
        "promotePr",
      ]);
      expect(state.prUrl).toBe("https://x/pr/1");
      expect(state.resolution?.outcome).toBe("ready");
      expect(existsSync(join(dir, "run-1.checkpoint.json"))).toBe(true);
    });
  });

  test("the result file carries the outcome, facts and branch", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir });
      const result = await runFinishMachine(state, deps);

      const written = JSON.parse(await Bun.file(resultPath(deps.audit)).text());
      expect(written.outcome).toBe("ready");
      expect(written.branch).toBe("feat/x");
      expect(written.headSha).toBe("sha1");
      expect(written.facts.gates).toEqual([{ name: "test", status: "green" }]);
      expect(result.headSha).toBe("sha1");
    });
  });

  test("open findings after the cap, advisor off: finalizeDraftPr, outcome draft, result.findings set", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A"), q("A"), q("A")] },
        fixIsNoop: true,
      });
      const result = await runFinishMachine(state, deps);

      expect(result.outcome).toBe("draft");
      expect(result.status).toBe("draft");
      expect(result.findings?.map((f) => f.title)).toEqual(["A"]);
      expect(result.reason).toContain("1 open");
      expect(trail).toContain("finalizeDraftPr");
      expect(trail).not.toContain("promotePr");
      expect(state.review.rounds).toBe(3);
    });
  });

  test("spec lens gives no verdict twice: its rounds are missing, the quality finding is still fixed, draft says 'spec review missing'", async () => {
    await withTempDir(async (dir) => {
      const { deps, trail, state } = makeMachineHarness({
        auditDir: dir,
        script: { spec: [MISSING, MISSING], quality: [q("Q")] },
      });
      const result = await runFinishMachine(state, deps);

      expect(trail).toContain("fix:review");
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("spec review missing");
      expect(result.facts?.reviewsMissing).toEqual(["spec"]);
      expect(trail).toContain("finalizeDraftPr");
    });
  });

  test("a lens that throws is a missing lens, not a failed finish", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        ops: {
          reviewBranch: async () => {
            throw new Error("session timed out");
          },
        },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("quality review missing");
    });
  });

  test("no forge: a clean run is local-only and still ready", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        ops: { promotePr: async () => ({ status: "local-only" as const }) },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("local-only");
      expect(result.outcome).toBe("ready");
    });
  });

  test("no forge: a draft outcome is local-only too, carrying its reason", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({
        auditDir: dir,
        script: { quality: [q("A"), q("A"), q("A")] },
        fixIsNoop: true,
        ops: { finalizeDraftPr: async () => ({ status: "local-only" as const }) },
      });
      const result = await runFinishMachine(state, deps);
      expect(result.status).toBe("local-only");
      expect(result.outcome).toBe("draft");
      assertDefined(result.reason);
    });
  });

  test("a red gate that survives its fix attempts leaves a draft naming the gate", async () => {
    await withTempDir(async (dir) => {
      const { deps, state } = makeMachineHarness({ auditDir: dir, qualityExit: () => 1 });
      const result = await runFinishMachine(state, deps);
      expect(result.outcome).toBe("draft");
      expect(result.reason).toContain("gates red: test");
      expect(result.facts?.gates).toEqual([
        { name: "test", status: "red", excerpt: expect.stringContaining("gate output") },
      ]);
    });
  });
});
