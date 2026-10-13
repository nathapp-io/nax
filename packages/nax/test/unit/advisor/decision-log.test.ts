/** nax#2491 P4: one info line per advisor decision, with its content; the no-channel warning is folded in. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeMockCallContext, makeNaxConfig, withTempDir } from "@test/helpers";
import type { AdviceAction, AdviceDecision, AdvisorCallContext, QuestionDraft } from "@/advisor";
import { _advisorServiceDeps, buildMenu, createAdvisor } from "@/advisor";
import { decisionLine, describeRuling } from "@/advisor/decision-log";
import { ADVISOR_DEFAULTS } from "@/config";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { AdviseOpOutput } from "@/operations";

const decision = (over: Partial<AdviceDecision> = {}): AdviceDecision => ({
  id: "D-1",
  questionId: "Q-1",
  kind: "finish-judgment",
  storyId: "US-002",
  chosenOptionId: "A",
  action: { type: "fix", instruction: "rename the export" },
  rationale: "r",
  confidence: "high",
  reversible: true,
  needsHumanConfirm: false,
  decidedAt: "t",
  model: "m",
  memoryMode: "stateless",
  auditRef: "advisor-audit/f/D-1.json",
  ...over,
});

describe("describeRuling", () => {
  const cases: [AdviceAction, string][] = [
    [{ type: "fix", instruction: "rename the export" }, "fix: rename the export"],
    [{ type: "waive", reason: "out of scope" }, "waive: out of scope"],
    [
      { type: "supersede", target: { kind: "ac", storyId: "US-001", acId: "AC-2" }, newText: "new text" },
      "supersede US-001 AC-2: new text",
    ],
    [{ type: "approve" }, "approve"],
    [
      { type: "carry", instruction: "use the helper", toStories: ["US-003", "US-004"] },
      "carry to US-003, US-004: use the helper",
    ],
  ];
  test.each(cases)("%j reads as %s", (action, text) => {
    expect(describeRuling(decision({ action }))).toBe(text);
  });

  test("a long ruling is cut to about 200 characters", () => {
    const text = describeRuling(decision({ action: { type: "fix", instruction: "x".repeat(500) } }));
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith("...")).toBe(true);
  });

  test("whitespace and newlines are folded", () => {
    expect(describeRuling(decision({ action: { type: "waive", reason: "a\n  b" } }))).toBe("waive: a b");
  });
});

describe("decisionLine", () => {
  test("caller, story, ruling summary and confidence", () => {
    expect(decisionLine(decision())).toBe(
      "Advisor ruling [finish-judgment] US-002: fix: rename the export (confidence high)",
    );
  });

  test("a feature-level decision has no story", () => {
    expect(decisionLine(decision({ storyId: undefined }))).toContain("[finish-judgment] feature:");
  });

  test("a flagged decision with no delivery channel says so on the same line", () => {
    const line = decisionLine(decision({ needsHumanConfirm: true }), { sent: false, reason: "no-channel" });
    expect(line).toEndWith("(confidence high); flagged, no delivery channel");
  });

  test("a flagged decision that was delivered is just marked flagged", () => {
    expect(decisionLine(decision({ needsHumanConfirm: true }), { sent: true })).toEndWith("; flagged");
  });
});

const original = { ..._advisorServiceDeps };
let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "debug" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => {
  resetLogger();
  Object.assign(_advisorServiceDeps, original);
});

const judgment: QuestionDraft = {
  kind: "finish-judgment",
  feature: "feat",
  storyId: "US-002",
  summary: "Transport widened",
  evidence: [],
  options: buildMenu({ kind: "finish-judgment", acceptanceEnabledForStory: true }),
};

function stub(reply: AdviseOpOutput): void {
  _advisorServiceDeps.callOp = (async () => reply) as typeof _advisorServiceDeps.callOp;
  _advisorServiceDeps.captureWorktreePatch = async () => ({ sha: "sha1", patch: "", patchTruncated: false });
  _advisorServiceDeps.readPrdText = async () => "{}";
  _advisorServiceDeps.costTotal = () => 0;
}

function ctxFor(dir: string): AdvisorCallContext {
  const config = makeNaxConfig({ advisor: { ...ADVISOR_DEFAULTS, enabled: true } });
  return {
    callCtx: makeMockCallContext({ config }),
    repoRoot: dir,
    outputDir: join(dir, "out"),
    feature: "feat",
    runId: "run-1",
    specPath: "spec.md",
    workdir: dir,
  };
}

describe("advisor service logging", () => {
  test("a hold (force-flagged, no channel) logs ONE info line with the content and no separate warning", async () => {
    await withTempDir(async (dir) => {
      stub({
        ok: true,
        reply: {
          optionId: "C",
          reason: "needs a human",
          rationale: "x",
          confidence: "low",
          reversible: true,
          needsHumanConfirm: true,
        },
      });
      await createAdvisor(ctxFor(dir)).advise(judgment);
      const advisor = logs.filter((e) => e.stage === "advisor");
      expect(advisor.filter((e) => e.level === "warn")).toHaveLength(0);
      const rulings = advisor.filter((e) => e.message.startsWith("Advisor ruling"));
      expect(rulings).toHaveLength(1);
      expect(rulings[0]?.level).toBe("info");
      expect(rulings[0]?.message).toContain("[finish-judgment] US-002: hold: needs a human (confidence low)");
      expect(rulings[0]?.message).toEndWith("; flagged, no delivery channel");
    });
  });
});
