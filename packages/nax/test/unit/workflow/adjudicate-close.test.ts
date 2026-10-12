import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { adjudicateResidual } from "@/workflow/adjudicate";
import { defaultWorkflowAdvisor, type WorkflowAdvisor } from "@/workflow/advisor";
import { deriveEndState } from "@/workflow/close";
import type { GateRunResult, WorkflowEndState } from "@/workflow/types";

const f = (id: string) => ({ id, kind: "quality" as const, severity: "important" as const, issue: `issue ${id}` });
const green: GateRunResult = { red: false, states: {}, findings: [] };
const red: GateRunResult = { red: true, states: { "full-suite": "red" }, findings: [] };

describe("adjudicateResidual", () => {
  test("stub advisor: hold every item, ledger one Ruling line each, gate line without diagnosis", async () => {
    const lines: string[] = [];
    const rulings = await adjudicateResidual(
      defaultWorkflowAdvisor,
      { storyId: "US-001", items: [f("F1"), f("F2")], redGates: ["full-suite"] },
      async (t) => {
        lines.push(t);
      },
    );
    expect(rulings.map((r) => [r.findingId, r.action, r.source])).toEqual([
      ["F1", "hold", "default"],
      ["F2", "hold", "default"],
    ]);
    expect(lines[0]).toStartWith("Ruling: hold F1");
    expect(lines.at(-1)).toBe("gate full-suite red at the cap (no diagnosis)");
  });

  test("advisor that throws or omits an item -> per-item default hold", async () => {
    const partial: WorkflowAdvisor = {
      answerQuestion: async () => null,
      ruleResidual: async () => ({
        rulings: [
          { findingId: "F1", action: "waive", text: "reviewer wrong", why: "w", costIfWrong: "c", source: "advisor" },
        ],
        diagnoses: { "full-suite": "flaky port" },
      }),
    };
    const lines: string[] = [];
    const rulings = await adjudicateResidual(
      partial,
      { storyId: "US-001", items: [f("F1"), f("F2")], redGates: ["full-suite"] },
      async (t) => {
        lines.push(t);
      },
    );
    expect(rulings.map((r) => r.action)).toEqual(["waive", "hold"]);
    expect(lines).toContain("gate full-suite red at the cap: flaky port");

    const throwing: WorkflowAdvisor = {
      answerQuestion: async () => null,
      ruleResidual: async () => {
        throw new Error("quota");
      },
    };
    expect(
      (await adjudicateResidual(throwing, { storyId: "US-001", items: [f("F3")], redGates: [] }, async () => {})).map(
        (r) => r.action,
      ),
    ).toEqual(["hold"]);
  });

  test("stub never answers questions", async () => {
    expect(
      await defaultWorkflowAdvisor.answerQuestion({ storyId: "US-001", status: "BLOCKED", concerns: "x" }),
    ).toBeNull();
  });
});

describe("adjudicateResidual duplicate and unknown rulings (P3-R10)", () => {
  let logs: LogEntry[] = [];
  beforeEach(() => {
    resetLogger();
    logs = [];
    initLogger({ level: "silent" });
    addSink((entry) => logs.push(entry));
  });
  afterEach(() => resetLogger());

  const ruling = (findingId: string, action: "waive" | "hold") => ({
    findingId,
    action,
    text: `${action} ${findingId}`,
    why: "w",
    costIfWrong: "c",
    source: "advisor" as const,
  });

  test("first ruling per finding wins; duplicates and unknown ids are warned about and ignored", async () => {
    const advisor: WorkflowAdvisor = {
      answerQuestion: async () => null,
      ruleResidual: async () => ({
        rulings: [ruling("F1", "waive"), ruling("F1", "hold"), ruling("F9", "waive")],
        diagnoses: {},
      }),
    };
    const rulings = await adjudicateResidual(
      advisor,
      { storyId: "US-001", items: [f("F1")], redGates: [] },
      async () => {},
    );
    expect(rulings.map((r) => [r.findingId, r.action])).toEqual([["F1", "waive"]]);
    const warns = logs.filter((e) => e.level === "warn");
    expect(warns).toHaveLength(2);
    expect(warns.map((e) => e.data)).toEqual([
      { storyId: "US-001", findingId: "F1" },
      { storyId: "US-001", findingId: "F9" },
    ]);
  });
});

describe("deriveEndState", () => {
  const cases: [Parameters<typeof deriveEndState>[0], WorkflowEndState][] = [
    [{ costStop: false, gates: green, suite: green, rulings: 0 }, "complete"],
    [{ costStop: false, gates: green, suite: green, rulings: 2 }, "complete-with-rulings"],
    [{ costStop: false, gates: green, suite: red, rulings: 2 }, "complete-gate-open"],
    [{ costStop: false, gates: red, suite: undefined, rulings: 0 }, "complete-gate-open"],
    [{ costStop: true, gates: green, suite: green, rulings: 0 }, "complete-gate-open"],
  ];
  test.each(cases)("%j -> %s", (input, state) => {
    expect(deriveEndState(input).state).toBe(state);
  });

  test("cost stop reason is cost-limit; red reason names the gates", () => {
    expect(deriveEndState({ costStop: true, rulings: 0 }).reason).toBe("cost-limit");
    expect(deriveEndState({ costStop: false, gates: green, suite: red, rulings: 0 }).reason).toBe("red: full-suite");
  });
});
