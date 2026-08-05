/**
 * StaticRulesProvider — US-003 per-stage rules budget derivation.
 *
 * US-003 AC 5-8: derive effective budget from rulesShare × request.budgetTokens,
 * capped at the configured global budgetTokens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type CanonicalRule,
  type ContextRequest,
  StaticRulesProvider,
  _staticRulesDeps,
} from "@/context/engine";

let origReadFile: typeof _staticRulesDeps.readFile;
let origFileExists: typeof _staticRulesDeps.fileExists;
let origGlobInDir: typeof _staticRulesDeps.globInDir;
let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

beforeEach(() => {
  origReadFile = _staticRulesDeps.readFile;
  origFileExists = _staticRulesDeps.fileExists;
  origGlobInDir = _staticRulesDeps.globInDir;
  origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
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
    // Effective budget 1600: a(800)+b(800)=1600 fits, c(400) does not → keep [a,b], drop c
    expect(result.chunks).toHaveLength(2);
    expect(result.budgetPressure?.droppedCount).toBe(1);
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
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.id).toContain("a");
    expect(result.budgetPressure?.droppedCount).toBe(1);
  });

  test("[US-003 AC 7] returns empty chunk list without throwing when .nax/rules/ is absent", async () => {
    // setupCanonical([]) plus no legacy files, allowLegacyClaudeMd=false (default).
    setupCanonical([]);
    _staticRulesDeps.fileExists = async () => false;
    _staticRulesDeps.readFile = async () => "";
    _staticRulesDeps.globInDir = () => [];
    const provider = new StaticRulesProvider();
    let result;
    expect(async () => {
      result = await provider.fetch(BASE_REQUEST);
    }).not.toThrow();
    expect(result!.chunks).toHaveLength(0);
  });

  test("[US-003 AC 8] when constructed without enforceBudget (default false) and budgetTokens is smaller than corpus, fetch returns one chunk per canonical rule (soft mode)", async () => {
    setupCanonical([
      { fileName: "a.md", id: "a", content: "A".repeat(40), tokens: 200, priority: 1 },
      { fileName: "b.md", id: "b", content: "B".repeat(40), tokens: 200, priority: 2 },
      { fileName: "c.md", id: "c", content: "C".repeat(40), tokens: 200, priority: 3 },
    ]);
    // No enforceBudget → soft mode; corpus total (600) exceeds budgetTokens (400)
    // → all 3 rules preserved as chunks, pressure reported.
    const provider = new StaticRulesProvider({ budgetTokens: 400 });
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(3);
    expect(result.budgetPressure).toBeDefined();
    expect(result.budgetPressure?.overageTokens).toBe(200);
    expect(result.budgetPressure?.droppedCount).toBe(0);
  });
});
