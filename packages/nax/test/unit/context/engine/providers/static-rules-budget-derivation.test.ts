/**
 * StaticRulesProvider — US-003 per-stage rules budget derivation.
 *
 * US-003 AC 5-8: derive effective budget from rulesShare × request.budgetTokens,
 * capped at the configured global budgetTokens.
 */

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { assertDefined } from "@test/helpers";
import { NaxConfigSchema } from "@/config/schemas";
import { _staticRulesDeps, type CanonicalRule, type ContextRequest, StaticRulesProvider } from "@/context/engine";
import { addSink, initLogger, type LogEntry, type Logger, resetLogger } from "@/logger";

let origReadFile: typeof _staticRulesDeps.readFile;
let origFileExists: typeof _staticRulesDeps.fileExists;
let origGlobInDir: typeof _staticRulesDeps.globInDir;
let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
let origApplySectionBudget: typeof _staticRulesDeps.applySectionBudget;

beforeEach(() => {
  origReadFile = _staticRulesDeps.readFile;
  origFileExists = _staticRulesDeps.fileExists;
  origGlobInDir = _staticRulesDeps.globInDir;
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  origApplySectionBudget = _staticRulesDeps.applySectionBudget;
  _staticRulesDeps.loadCanonicalRules = async () => [];
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.readFile = async () => "";
  _staticRulesDeps.globInDir = () => [];
});

afterEach(() => {
  _staticRulesDeps.readFile = origReadFile;
  _staticRulesDeps.fileExists = origFileExists;
  _staticRulesDeps.globInDir = origGlobInDir;
  _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  _staticRulesDeps.applySectionBudget = origApplySectionBudget;
});

const BASE_REQUEST: ContextRequest = {
  storyId: "US-003",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

describe("StaticRulesProvider — US-003 per-stage rules budget derivation", () => {
  test("[US-003 AC 5] effective budget = rulesShare * request.budgetTokens (uncapped at 1600)", async () => {
    // request.budgetTokens=4000, rulesShare=0.4 → effective=1600, global budgetTokens=8192 (cap, not hit).
    // In soft mode (enforce=false), total=2000 must report overageTokens = 2000-1600 = 400.
    // Without rulesShare, current code uses 8192 → overageTokens would be 0.
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 1000, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 1000, priority: 2 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 8192, rulesShare: 0.4 });
    const request: ContextRequest = { ...BASE_REQUEST, budgetTokens: 4000 };
    const result = await provider.fetch(request);
    expect(result.chunks).toHaveLength(2);
    expect(result.budgetPressure?.overageTokens).toBe(400);
  });

  test("[US-003 AC 5] effective budget enforced at 1600 truncates when total > 1600 (e.g. tokens=2000)", async () => {
    // 2000 tokens across three rules, priority-sorted. Effective budget 1600 = rulesShare 0.4 * 4000.
    // With enforce=true, contiguous-tail truncation applies at 1600, dropping the tail.
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 800, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 800, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 400, priority: 3 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 8192, rulesShare: 0.4, enforceBudget: true });
    const request: ContextRequest = { ...BASE_REQUEST, budgetTokens: 4000 };
    const result = await provider.fetch(request);
    // Effective budget 1600: a(800)+b(800)=1600 fits, c(400) does not → keep [a,b], drop c,
    // append a standalone notice chunk (#1610) — 2 rule chunks + 1 notice chunk.
    expect(result.chunks).toHaveLength(3);
    expect(result.budgetPressure?.droppedCount).toBe(1);
    // #1610: a dropped-tail must surface in the emitted prompt content, not just telemetry,
    // and as its OWN chunk — not spliced into whichever rule chunk happens to sort last,
    // so it can't be silently eaten by downstream dedupe of a rule chunk.
    const noticeChunk = result.chunks[result.chunks.length - 1];
    expect(noticeChunk?.id).toBe("static-rules:__budget-notice__:US-003");
    expect(noticeChunk?.kind).toBe("static");
    expect(noticeChunk?.content).toContain("rule budget exceeded");
    expect(noticeChunk?.content).toContain("c#");
    // The rule chunks themselves stay unmodified by the notice.
    for (const chunk of result.chunks.slice(0, -1)) {
      expect(chunk.content).not.toContain("rule budget exceeded");
    }
  });

  test("[#1610] soft mode (enforceBudget: false) never appends a notice chunk even when droppedIds is non-empty", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 800, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 800, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 400, priority: 3 },
    ]);
    // enforceBudget defaults to false — soft mode keeps every section as a
    // chunk even though applySectionBudget still reports droppedIds.
    const provider = new StaticRulesProvider({ budgetTokens: 8192, rulesShare: 0.4 });
    const request: ContextRequest = { ...BASE_REQUEST, budgetTokens: 4000 };
    const result = await provider.fetch(request);
    // Sanity: a drop is actually being reported by the section budget here —
    // otherwise this test would pass vacuously regardless of the enforceBudget gate.
    expect(result.budgetPressure?.droppedCount).toBeGreaterThan(0);
    expect(result.chunks).toHaveLength(3);
    for (const chunk of result.chunks) {
      expect(chunk.content).not.toContain("rule budget exceeded");
    }
  });

  test("[US-003 AC 6] global budgetTokens caps the effective budget (rulesShare * stage > global)", async () => {
    // request.budgetTokens=12000, rulesShare=0.9 → 10800 raw, capped at 8192.
    // Soft mode + total=9000 (between 8192 and 10800):
    //   With effective=8192 (capped): overageTokens = 9000-8192 = 808
    //   With effective=10800 (uncapped): overageTokens = 0
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 5000, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 4000, priority: 2 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 8192, rulesShare: 0.9 });
    const request: ContextRequest = { ...BASE_REQUEST, budgetTokens: 12000 };
    const result = await provider.fetch(request);
    expect(result.chunks).toHaveLength(2);
    expect(result.budgetPressure?.overageTokens).toBe(808);
  });

  test("[US-003 AC 6] global cap enforced: corpus > 8192 and < 10800 truncates under the cap, not the share", async () => {
    // Same fixture as above but enforce=true. With effective=8192, a(5000)+b(4000)=9000 → drop b.
    // With effective=10800, both would fit.
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 5000, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 4000, priority: 2 },
    ]);
    const provider = new StaticRulesProvider({ budgetTokens: 8192, rulesShare: 0.9, enforceBudget: true });
    const request: ContextRequest = { ...BASE_REQUEST, budgetTokens: 12000 };
    const result = await provider.fetch(request);
    // 1 retained rule chunk + 1 standalone notice chunk (#1610).
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.id).toContain("a");
    expect(result.budgetPressure?.droppedCount).toBe(1);
  });

  test("[#1610] enforceBudget: true with an invalid effective budget (0) still surfaces a budget notice when sections existed", async () => {
    setupCanonical([{ fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 800, priority: 1 }]);
    // rulesShare: 0 drives the derived effective budget to 0, an invalid
    // threshold — applySectionBudget drops every section (droppedIds = all)
    // and effectiveSections is empty, hitting the "totalScopedSections > 0"
    // branch rather than the "everything filtered by scope" branch.
    const provider = new StaticRulesProvider({ budgetTokens: 8192, rulesShare: 0, enforceBudget: true });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("rule budget exceeded");
  });

  test("[US-003 AC 7] returns empty chunk list without throwing when .nax/rules/ is absent", async () => {
    // setupCanonical([]) plus no legacy files, allowLegacyClaudeMd=false (default).
    setupCanonical([]);
    _staticRulesDeps.fileExists = async () => false;
    _staticRulesDeps.readFile = async () => "";
    _staticRulesDeps.globInDir = () => [];
    const provider = new StaticRulesProvider();
    let result: Awaited<ReturnType<typeof provider.fetch>> | undefined;
    expect(async () => {
      result = await provider.fetch(BASE_REQUEST);
    }).not.toThrow();
    assertDefined(result, "fetch() result");
    expect(result.chunks).toHaveLength(0);
  });

  test("[US-003 AC 8] when constructed without enforceBudget (default false) and budgetTokens is smaller than corpus, fetch returns one chunk per canonical rule (soft mode)", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 200, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 200, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 200, priority: 3 },
    ]);
    // No enforceBudget → soft mode; corpus total (600) exceeds budgetTokens (400)
    // → all 3 rules preserved as chunks, pressure reported.
    //
    // Dispatch shape: the provider's soft-mode contract is "report overage
    // but never drop". The section-level `applySectionBudget` does not
    // distinguish soft vs. enforce — it always reports a potential
    // droppedIds. Mock it to encode the soft-mode shape the provider
    // composes: all sections returned, overageTokens = total − budget,
    // droppedIds empty.
    const origApply = _staticRulesDeps.applySectionBudget;
    _staticRulesDeps.applySectionBudget = ((sections: Parameters<typeof origApply>[0], budgetTokens: number) => {
      const totalTokens = sections.reduce((sum, s) => sum + s.tokens, 0);
      return {
        retainedSections: [...sections],
        totalTokens,
        usedTokens: totalTokens,
        droppedIds: [],
        overageTokens: Math.max(0, totalTokens - budgetTokens),
      };
    }) as typeof origApply;
    try {
      const provider = new StaticRulesProvider({ budgetTokens: 400 });
      const result = await provider.fetch(BASE_REQUEST);
      expect(result.chunks).toHaveLength(3);
      expect(result.budgetPressure).toBeDefined();
      expect(result.budgetPressure?.overageTokens).toBe(200);
      expect(result.budgetPressure?.droppedCount).toBe(0);
    } finally {
      _staticRulesDeps.applySectionBudget = origApply;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nax#1775 — appliesTo inert-scoping warning — absorbed from
// static-rules-inert-warn.test.ts
//
// A rule declaring `appliesTo:` that gets admitted only because
// `request.scopeFiles` is empty is a silent scoping bug, not a benign
// default. `appliesToInertCount` already existed on the scoping report but
// was invisible outside manifest telemetry — this pins the accompanying
// `logger.warn`.
// ─────────────────────────────────────────────────────────────────────────────

let warnSpy: Mock<Logger["warn"]> | undefined;

const INERT_BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupInertCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

describe("StaticRulesProvider — appliesTo inert-scoping warning (nax#1775)", () => {
  beforeEach(async () => {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    const logger = initLogger({ level: "silent" });
    warnSpy = spyOn(logger, "warn");
  });

  afterEach(async () => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    const { resetLogger } = await import("@/logger");
    resetLogger();
  });

  test("warns when an appliesTo: rule is admitted because scopeFiles is empty", async () => {
    setupInertCanonical([{ fileName: "agents.md", content: "Agent-specific rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...INERT_BASE_REQUEST, scopeFiles: [] });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeDefined();
    expect(call?.[2]).toMatchObject({ storyId: "US-001", appliesToInertCount: 1 });
  });

  test("warns when scopeFiles is entirely absent (undefined)", async () => {
    setupInertCanonical([{ fileName: "agents.md", content: "Agent-specific rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...INERT_BASE_REQUEST, scopeFiles: undefined });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeDefined();
  });

  test("does not warn when scopeFiles is populated (appliesTo scoping is live)", async () => {
    setupInertCanonical([{ fileName: "agents.md", content: "Agent-specific rules", appliesTo: ["src/agents/**"] }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...INERT_BASE_REQUEST, scopeFiles: ["src/agents/manager.ts"] });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeUndefined();
  });

  test("does not warn when no rule declares appliesTo:", async () => {
    setupInertCanonical([{ fileName: "global.md", content: "Global rules" }]);
    const provider = new StaticRulesProvider();

    await provider.fetch({ ...INERT_BASE_REQUEST, scopeFiles: [] });

    const call = warnSpy?.mock.calls.find(
      (c) => c[0] === "static-rules" && c[1] === "appliesTo rules admitted unconditionally — scope-file set is empty",
    );
    expect(call).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 budget warnings — absorbed from static-rules-budget-warnings.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const WARN_BASE_REQUEST: ContextRequest = {
  storyId: "US-003",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupWarnCanonical(rules: CanonicalRule[]): void {
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
  afterEach(() => {
    resetLogger();
  });

  test("AC1: soft-budget truncation warning is counterfactual and names enforceBudget", async () => {
    setupWarnCanonical(overBudgetRules(200));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 400, enforceBudget: false }).fetch(WARN_BASE_REQUEST),
    );

    const message = calls.find((call) => call.message.includes("Rule sections"))?.message;
    expect(message).toMatch(/would be truncated/i);
    expect(message).not.toMatch(/were truncated/i);
    // MSG-1 — the message names the real config path, not a bare knob name.
    expect(message).toContain("context.v2.rules.enforceBudget");
  });

  test("AC2: enforced-budget truncation warning retains its existing wording", async () => {
    setupWarnCanonical(overBudgetRules(200));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 400, enforceBudget: true }).fetch(WARN_BASE_REQUEST),
    );

    expect(calls.find((call) => call.message.includes("Rule sections"))?.message).toBe(
      "Rule sections truncated by static rules budget",
    );
  });

  test("AC5: rules within a soft budget emit no truncation warning", async () => {
    setupWarnCanonical(overBudgetRules(50));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 1000, enforceBudget: false }).fetch(WARN_BASE_REQUEST),
    );

    expect(calls.filter((call) => call.message.includes("truncated"))).toHaveLength(0);
  });

  test("AC6: soft approaching-budget warning names enforceBudget without claiming drops", async () => {
    setupWarnCanonical(overBudgetRules(150));
    const calls = await captureWarnCalls(() =>
      new StaticRulesProvider({ budgetTokens: 400, enforceBudget: false }).fetch(WARN_BASE_REQUEST),
    );

    const message = calls.find((call) => call.message.includes("approaching"))?.message;
    expect(message).toContain("context.v2.rules.enforceBudget");
    expect(message).not.toMatch(/were truncated|were dropped/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M3 allowLegacyClaudeMd default tests — absorbed from
// static-rules-legacy-default.test.ts
//
// AC-28/AC-31: The default for allowLegacyClaudeMd must be false.
// Legacy CLAUDE.md fallback must be opt-in, not opt-out.
// ─────────────────────────────────────────────────────────────────────────────

const LEGACY_BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

describe("StaticRulesProvider — #508-M3 allowLegacyClaudeMd defaults to false", () => {
  test("returns empty chunks by default when no canonical rules and CLAUDE.md exists", async () => {
    // Canonical rules: empty (no .nax/rules/)
    _staticRulesDeps.loadCanonicalRules = async () => [];
    // CLAUDE.md exists and has content — legacy fallback would pick this up
    _staticRulesDeps.fileExists = async (path: string) => path.endsWith("CLAUDE.md");
    _staticRulesDeps.readFile = async () => "# Project rules\n\nUse async/await.";

    // RED: current default is true — provider falls back to CLAUDE.md and returns a chunk.
    // GREEN: default false — no legacy fallback, returns empty.
    const provider = new StaticRulesProvider(); // no options
    const result = await provider.fetch(LEGACY_BASE_REQUEST);
    expect(result.chunks).toHaveLength(0);
  });

  test("returns legacy chunks when explicitly opted in with allowLegacyClaudeMd: true", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => [];
    _staticRulesDeps.fileExists = async (path: string) => path.endsWith("CLAUDE.md");
    _staticRulesDeps.readFile = async () => "# Rules\n\nUse async/await.";

    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: true });
    const result = await provider.fetch(LEGACY_BASE_REQUEST);
    // Explicit opt-in must still work
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  test("NaxConfigSchema default for allowLegacyClaudeMd is false", () => {
    const config = NaxConfigSchema.parse({});
    // RED: current schema default is true.
    // GREEN: flipped to false.
    expect(config.context?.v2?.rules?.allowLegacyClaudeMd).toBe(false);
  });
});
