import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine/providers/static-rules";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-003",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

let originalLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

beforeEach(() => {
  originalLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
});

afterEach(() => {
  _staticRulesDeps.loadCanonicalRules = originalLoadCanonicalRules;
  resetLogger();
});

function setupCanonical(rules: CanonicalRule[]): void {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

async function captureWarnCalls(fetch: () => Promise<unknown>): Promise<LogEntry[]> {
  const calls: LogEntry[] = [];
  initLogger({ level: "silent", suppressConsole: true });
  const unsubscribe = addSink((entry) => {
    if (entry.level === "warn") calls.push(entry);
  });
  try {
    await fetch();
    return calls;
  } finally {
    unsubscribe();
  }
}

function overBudgetRules(tokens: number): CanonicalRule[] {
  return [
    { fileName: "a.md", id: "a", content: "A".repeat(40), tokens, priority: 1 },
    { fileName: "b.md", id: "b", content: "B".repeat(40), tokens, priority: 2 },
    { fileName: "c.md", id: "c", content: "C".repeat(40), tokens, priority: 3 },
  ];
}

describe("StaticRulesProvider budget warnings — US-003", () => {
  test("AC1: soft-budget truncation warning is counterfactual and names enforceBudget", async () => {
    setupCanonical(overBudgetRules(200));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 400, enforceBudget: false }).fetch(BASE_REQUEST),
    );

    const message = calls.find((call) => call.message.includes("Rule sections"))?.message;
    expect(message).toMatch(/would be truncated/i);
    expect(message).not.toMatch(/were truncated/i);
    expect(message).toContain("enforceBudget");
  });

  test("AC2: enforced-budget truncation warning retains its existing wording", async () => {
    setupCanonical(overBudgetRules(200));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 400, enforceBudget: true }).fetch(BASE_REQUEST),
    );

    expect(calls.find((call) => call.message.includes("Rule sections"))?.message).toBe(
      "Rule sections truncated by static rules budget",
    );
  });

  test("AC5: rules within a soft budget emit no truncation warning", async () => {
    setupCanonical(overBudgetRules(50));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 1000, enforceBudget: false }).fetch(BASE_REQUEST),
    );

    expect(calls.filter((call) => call.message.includes("truncated"))).toHaveLength(0);
  });

  test("AC6: soft approaching-budget warning names enforceBudget without claiming drops", async () => {
    setupCanonical(overBudgetRules(150));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 400, enforceBudget: false }).fetch(BASE_REQUEST),
    );

    const message = calls.find((call) => call.message.includes("approaching"))?.message;
    expect(message).toContain("enforceBudget");
    expect(message).not.toMatch(/were truncated|were dropped/i);
  });
});
