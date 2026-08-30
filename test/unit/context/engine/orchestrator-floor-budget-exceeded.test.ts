/**
 * nax#1776 — static-rules floor items silently blow the stage budget.
 *
 * Floor chunks (`static`, `feature`, `test-coverage` kinds — see
 * `FLOOR_KINDS`) bypass packing's budget check entirely, so
 * `manifest.usedTokens` can land 2-3x over `manifest.totalBudgetTokens` with
 * nothing surfacing it. This pins the `logger.warn` that names the
 * responsible floor items and their token cost when that happens.
 *
 * Distinct from `orchestrator-floor-overage.test.ts`'s AC-4 warn, which
 * compares against `effectiveBudget` (the post-`availableBudgetTokens`,
 * post-reserve ceiling) — this one compares against the raw
 * `manifest.totalBudgetTokens` (== `request.budgetTokens`), the number an
 * operator actually configured. Lives in its own file for the same reason —
 * `orchestrator.test.ts` is at the 800-line ceiling.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, type MockLogger, makeLogger } from "@test/helpers";
import { _orchestratorDeps, ContextOrchestrator } from "@/context";
import type { ContextRequest, IContextProvider } from "@/context/engine/types";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "tdd-test-writer",
  role: "tdd",
  budgetTokens: 8_000,
  providerIds: ["rules-provider"],
};

const WARN_MESSAGE = "Stage budget exceeded by floor items";

function makeRulesProvider(): IContextProvider {
  return {
    id: "rules-provider",
    kind: "static",
    fetch: async () => ({
      chunks: [
        {
          id: "static-rules:big-rule",
          kind: "static",
          scope: "project",
          role: ["all"],
          content: "x".repeat(88_000),
          tokens: 22_000,
          rawScore: 1.0,
        },
      ],
      pullTools: [],
    }),
  };
}

describe("ContextOrchestrator.assemble() — floor items exceeding totalBudgetTokens (nax#1776)", () => {
  let origGetLogger: typeof _orchestratorDeps.getLogger;
  let mockLogger: MockLogger;

  beforeEach(() => {
    origGetLogger = _orchestratorDeps.getLogger;
    mockLogger = makeLogger();
    _orchestratorDeps.getLogger = () => mockLogger;
  });

  afterEach(() => {
    _orchestratorDeps.getLogger = origGetLogger;
  });

  test("warns, naming the floor item and its token cost, when usedTokens exceeds totalBudgetTokens", async () => {
    const orch = new ContextOrchestrator([makeRulesProvider()]);

    const bundle = await orch.assemble(BASE_REQUEST);

    expect(bundle.manifest.usedTokens).toBeGreaterThan(bundle.manifest.totalBudgetTokens);

    const call = mockLogger.calls.find((c) => c.level === "warn" && c.message === WARN_MESSAGE);
    assertDefined(call, "floor-budget-exceeded warn log call");
    const data = call.data ?? {};
    expect(Object.keys(data)[0]).toBe("storyId");
    expect(data.storyId).toBe("US-001");
    expect(data.stage).toBe("tdd-test-writer");
    expect(data.usedTokens).toBe(bundle.manifest.usedTokens);
    expect(data.totalBudgetTokens).toBe(8_000);
    expect(data.floorOverageCount).toBe(1);
    expect(Array.isArray(data.heaviestFloorItems)).toBe(true);
    expect(data.heaviestFloorItems).toContainEqual({ id: "static-rules:big-rule", tokens: 22_000 });
  });

  test("caps the enumerated floor items at 10, heaviest first, but counts them all", async () => {
    // The overage condition holds on nearly every stage of every story and the
    // floor routinely runs to 60+ chunks, so the warn must not dump the lot.
    const provider: IContextProvider = {
      id: "rules-provider",
      kind: "static",
      fetch: async () => ({
        chunks: Array.from({ length: 25 }, (_, i) => ({
          id: `static-rules:rule-${String(i).padStart(2, "0")}`,
          kind: "static" as const,
          scope: "project" as const,
          role: ["all"] as ["all"],
          content: `### rule-${i}.md\n\nbody`,
          tokens: 1_000 + i,
          rawScore: 1.0,
        })),
        pullTools: [],
      }),
    };
    const orch = new ContextOrchestrator([provider]);

    await orch.assemble(BASE_REQUEST);

    const call = mockLogger.calls.find((c) => c.level === "warn" && c.message === WARN_MESSAGE);
    assertDefined(call, "floor-budget-exceeded warn log call");
    const data = call.data ?? {};
    expect(data.floorOverageCount).toBe(25);
    // Exactly the 10 heaviest, heaviest first — rule-24 (1024) down to rule-15 (1015).
    expect(data.heaviestFloorItems).toEqual([
      { id: "static-rules:rule-24", tokens: 1024 },
      { id: "static-rules:rule-23", tokens: 1023 },
      { id: "static-rules:rule-22", tokens: 1022 },
      { id: "static-rules:rule-21", tokens: 1021 },
      { id: "static-rules:rule-20", tokens: 1020 },
      { id: "static-rules:rule-19", tokens: 1019 },
      { id: "static-rules:rule-18", tokens: 1018 },
      { id: "static-rules:rule-17", tokens: 1017 },
      { id: "static-rules:rule-16", tokens: 1016 },
      { id: "static-rules:rule-15", tokens: 1015 },
    ]);
  });

  test("does not warn when floor items fit within totalBudgetTokens", async () => {
    const orch = new ContextOrchestrator([
      {
        id: "rules-provider",
        kind: "static",
        fetch: async () => ({
          chunks: [
            {
              id: "static-rules:small-rule",
              kind: "static",
              scope: "project",
              role: ["all"],
              content: "small rule content",
              tokens: 100,
              rawScore: 1.0,
            },
          ],
          pullTools: [],
        }),
      },
    ]);

    const bundle = await orch.assemble(BASE_REQUEST);

    expect(bundle.manifest.usedTokens).toBeLessThanOrEqual(bundle.manifest.totalBudgetTokens);
    const call = mockLogger.calls.find((c) => c.level === "warn" && c.message === WARN_MESSAGE);
    expect(call).toBeUndefined();
  });
});
