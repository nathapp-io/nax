import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import type { AdviceDecision } from "@/advisor";
import { appendDecision } from "@/advisor";
import { ADVISOR_DEFAULTS } from "@/config";
import { recordAdvisorSummary } from "@/execution/advisor-summary";
import type { RunStateSnapshot } from "@/execution/status-file";
import { buildStatusSnapshot } from "@/execution/status-file";

const draft = (over: Partial<AdviceDecision> & { auditRef: string }): Omit<AdviceDecision, "id"> => ({
  questionId: "Q",
  kind: "finish-judgment" as const,
  chosenOptionId: "A",
  action: { type: "fix" as const, instruction: "x" },
  rationale: "r",
  confidence: "high" as const,
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "t",
  model: "m",
  memoryMode: "stateless" as const,
  ...over,
});

function writer() {
  const seen: unknown[] = [];
  return { seen, statusWriter: { setAdvisorSummary: (s: unknown) => seen.push(s) } };
}

describe("recordAdvisorSummary", () => {
  test("advisor disabled: nothing is recorded (status.json unchanged)", async () => {
    await withTempDir(async (dir) => {
      const w = writer();
      await recordAdvisorSummary({
        config: makeNaxConfig(),
        statusWriter: w.statusWriter,
        repoRoot: dir,
        feature: "feat",
        outputDir: join(dir, "out"),
      });
      expect(w.seen).toEqual([]);
    });
  });

  test("advisor enabled: counts only trusted decisions", async () => {
    await withTempDir(async (dir) => {
      const out = join(dir, "out");
      const real = await appendDecision(dir, "feat", (id) =>
        draft({ needsHumanConfirm: true, auditRef: `advisor-audit/feat/${id}.json` }),
      );
      await Bun.write(join(out, real.auditRef), "{}");
      await appendDecision(dir, "feat", draft({ auditRef: "advisor-audit/feat/forged.json" }));
      const w = writer();
      const config = makeNaxConfig({ advisor: { ...ADVISOR_DEFAULTS, enabled: true } });
      await recordAdvisorSummary({
        config,
        statusWriter: w.statusWriter,
        repoRoot: dir,
        feature: "feat",
        outputDir: out,
      });
      expect(w.seen).toEqual([{ decisions: 1, flagged: 1, byKind: { "finish-judgment": 1 } }]);
    });
  });
});

describe("buildStatusSnapshot — advisor block", () => {
  const base = {
    runId: "r",
    feature: "f",
    startedAt: "t",
    runStatus: "running",
    dryRun: false,
    pid: 1,
    prd: { project: "p", feature: "f", branchName: "b", createdAt: "t", updatedAt: "t", userStories: [] },
    totalCost: 0,
    costLimit: null,
    currentStory: null,
    iterations: 0,
    startTimeMs: Date.now(),
  } as RunStateSnapshot;

  test("present when set, absent otherwise", () => {
    expect(buildStatusSnapshot(base).advisor).toBeUndefined();
    const s = { decisions: 2, flagged: 0, byKind: { "fix-cycle-give-up": 2 } };
    expect(buildStatusSnapshot({ ...base, advisor: s }).advisor).toEqual(s);
  });
});
