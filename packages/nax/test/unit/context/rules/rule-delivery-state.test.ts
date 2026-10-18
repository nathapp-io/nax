/**
 * US-005 — the run-scoped state behind the rule-delivery handlers: the session
 * delivery map, the directory/package caches, the direct rule-file read, the
 * `before_compaction` reset and the fail-open path.
 *
 * Every `_ruleDeliveryDeps` stub is restored after each test: the seam is
 * module-scoped, so one leaked stub would silently reinterpret every later test
 * file in the same process (`mock.module()` is banned for exactly this reason).
 *
 * The AC id is the test-name prefix.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  beforeCompactionPayload,
  beforeToolPayload,
  callBeforeCompaction,
  callBeforeTool,
  handlerContext,
  outcomeText,
  seedPackage,
  seedRule,
  withTempDir,
  withWarnSpy,
} from "@test/helpers";
import { _ruleDeliveryDeps, createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import type { ResolvedRule, ResolvedRuleSet, RulesForFileInput } from "@/context/rules/rule-set";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const PACKAGE = "packages/nax";
const A_PATH = `${PACKAGE}/src/a.ts`;
const B_PATH = `${PACKAGE}/src/b.ts`;
const ORG_RULE_PATH = "/abs/org/r.md";
const STUB_BODY = "STUB-RULE-BODY";

const REAL_DEPS = { ..._ruleDeliveryDeps };

afterEach(() => {
  Object.assign(_ruleDeliveryDeps, REAL_DEPS);
});

const read = (path: string) => beforeToolPayload("Read", { path });
const write = (path: string) => beforeToolPayload("Write", { path, content: "x" });

/** A resolved rule with only the fields the handler reads. */
function stubRule(overrides: Partial<ResolvedRule> = {}): ResolvedRule {
  return {
    fileName: "r.md",
    content: STUB_BODY,
    ruleId: "r",
    source: "repo",
    displayPath: ".nax/rules/r.md",
    ...overrides,
  };
}

function ruleSet(rules: readonly ResolvedRule[]): ResolvedRuleSet {
  return {
    rules,
    repoRulesTotal: rules.length,
    repoRulesMatchedPaths: rules.length,
    packageRulesCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Direct rule-file reads
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — a direct read of a rule's own file", () => {
  test("AC-10: an override rule's absolute display path is allowed, outside the repo root", async () => {
    await withTempDir(async (repoRoot) => {
      const rule = stubRule({ ruleId: "org", source: "override", displayPath: ORG_RULE_PATH });
      _ruleDeliveryDeps.resolveRuleSet = async () => ruleSet([rule]);
      const set = createRuleDeliveryHandlers({ repoRoot, overrideDir: "/abs/org", overrideMode: "merge" });

      const outcome = await callBeforeTool(
        set,
        read(ORG_RULE_PATH),
        handlerContext({ role: "wf-implementer", sessionName: "sess-rule-file" }),
      );

      expect(outcome).toEqual({ kind: "allow" });
    });
  });

  test("AC-11: that read delivered the rule, so the Write it makes safe is not blocked", async () => {
    await withTempDir(async (repoRoot) => {
      const rule = stubRule({ ruleId: "org", source: "override", displayPath: ORG_RULE_PATH });
      _ruleDeliveryDeps.resolveRuleSet = async () => ruleSet([rule]);
      _ruleDeliveryDeps.rulesForFile = async () => [rule];
      const set = createRuleDeliveryHandlers({ repoRoot, overrideDir: "/abs/org", overrideMode: "merge" });
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-rule-file-write" });

      expect(await callBeforeTool(set, read(ORG_RULE_PATH), ctx)).toEqual({ kind: "allow" });
      expect(await callBeforeTool(set, write(A_PATH), ctx)).toEqual({ kind: "allow" });
    });
  });

  test("a repo rule's file read inside the repo is allowed too", async () => {
    await withTempDir(async (repoRoot) => {
      await seedRule(repoRoot, "r.md", "## R\n\nRULE-R-BODY\n");
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-repo-rule-file" });

      expect(await callBeforeTool(set, read(".nax/rules/r.md"), ctx)).toEqual({ kind: "allow" });
      // Delivered by that read — a Write governed by `r` is not blocked.
      expect(await callBeforeTool(set, write(`${PACKAGE}/src/x.ts`), ctx)).toEqual({ kind: "allow" });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The caches
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — the run-scoped caches", () => {
  test("AC-16: the per-file resolver is called once, with the normalized repo-relative path and the configured repoRoot", async () => {
    await withTempDir(async (repoRoot) => {
      const calls: RulesForFileInput[] = [];
      _ruleDeliveryDeps.rulesForFile = async (input) => {
        calls.push(input);
        return [stubRule()];
      };
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });

      await callBeforeTool(set, read(A_PATH), handlerContext({ role: "wf-implementer", sessionName: "sess-seam" }));

      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe(A_PATH);
      expect(calls[0]?.repoRoot).toBe(repoRoot);
    });
  });

  test("AC-17: two Reads in one directory cost one per-file lookup and one package rule-set lookup", async () => {
    await withTempDir(async (repoRoot) => {
      await seedPackage(repoRoot, PACKAGE);
      let fileLookups = 0;
      let packageLookups = 0;
      _ruleDeliveryDeps.rulesForFile = async () => {
        fileLookups += 1;
        return [stubRule()];
      };
      _ruleDeliveryDeps.resolveRuleSet = async (input) => {
        if (input.packageDir === join(repoRoot, PACKAGE)) packageLookups += 1;
        return ruleSet([]);
      };
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-cache" });

      await callBeforeTool(set, read(A_PATH), ctx);
      await callBeforeTool(set, read(B_PATH), ctx);

      expect(fileLookups).toBe(1);
      expect(packageLookups).toBe(1);
    });
  });

  test("the package's own rule set matches a later file that the first one did not reveal", async () => {
    await withTempDir(async (repoRoot) => {
      // `rulesForFile` answers for a.ts only; r2 governs b.ts alone. The second
      // Read must still find r2 — from the cached package set, not from a
      // second per-file lookup.
      _ruleDeliveryDeps.rulesForFile = async () => [stubRule({ ruleId: "r1", displayPath: ".nax/rules/r1.md" })];
      _ruleDeliveryDeps.resolveRuleSet = async () =>
        ruleSet([
          stubRule({ ruleId: "r1", displayPath: ".nax/rules/r1.md" }),
          stubRule({ ruleId: "r2", displayPath: ".nax/rules/r2.md", appliesTo: [B_PATH] }),
        ]);
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-package-set" });

      await callBeforeTool(set, read(A_PATH), ctx);
      const second = await callBeforeTool(set, read(B_PATH), ctx);

      expect(second.kind).toBe("nudge");
      expect(outcomeText(second)).toContain("### r2 (.nax/rules/r2.md)");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-open
// ─────────────────────────────────────────────────────────────────────────────

describe("before_tool — rule resolution fails", () => {
  test("AC-18: the call resolves to allow rather than failing the loop", async () => {
    await withTempDir(async (repoRoot) => {
      _ruleDeliveryDeps.rulesForFile = async () => {
        throw new Error("rule resolution exploded");
      };
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });

      const outcome = await callBeforeTool(
        set,
        read(A_PATH),
        handlerContext({ role: "wf-implementer", sessionName: "sess-fail", storyId: "US-005" }),
      );

      expect(outcome).toEqual({ kind: "allow" });
    });
  });

  test("AC-19: exactly one warn on 'rules', with storyId as the first data key", async () => {
    await withTempDir(async (repoRoot) => {
      _ruleDeliveryDeps.rulesForFile = async () => {
        throw new Error("rule resolution exploded");
      };
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });

      await withWarnSpy(async (warnSpy) => {
        await callBeforeTool(
          set,
          read(A_PATH),
          handlerContext({ role: "wf-implementer", sessionName: "sess-fail-log", storyId: "US-005" }),
        );

        const warnings = warnSpy.mock.calls.filter((call) => call[0] === "rules");
        expect(warnings).toHaveLength(1);
        const data = warnings[0]?.[2];
        expect(data).toBeDefined();
        if (data === undefined) return;
        expect(Object.keys(data)[0]).toBe("storyId");
        expect(data.storyId).toBe("US-005");
      });
    });
  });

  test("AC-20: a failure delivers nothing, so the next Read of that path is nudged once resolution works", async () => {
    await withTempDir(async (repoRoot) => {
      let attempts = 0;
      _ruleDeliveryDeps.rulesForFile = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt fails");
        return [stubRule()];
      };
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-recover" });

      expect(await callBeforeTool(set, read(A_PATH), ctx)).toEqual({ kind: "allow" });

      const recovered = await callBeforeTool(set, read(A_PATH), ctx);

      expect(recovered.kind).toBe("nudge");
      expect(outcomeText(recovered)).toContain(STUB_BODY);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

describe("before_compaction — the session reset", () => {
  test("AC-14: after compaction the session is nudged again for a rule it had already seen", async () => {
    await withTempDir(async (repoRoot) => {
      await seedPackage(repoRoot, PACKAGE);
      await seedRule(repoRoot, "r.md", "## R\n\nRULE-R-BODY\n");
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
      const ctx = handlerContext({ role: "wf-implementer", sessionName: "sess-compact" });

      expect((await callBeforeTool(set, read(A_PATH), ctx)).kind).toBe("nudge");
      expect(await callBeforeCompaction(set, beforeCompactionPayload(), ctx)).toBeUndefined();

      const after = await callBeforeTool(set, read(A_PATH), ctx);

      expect(after.kind).toBe("nudge");
      expect(outcomeText(after)).toContain("RULE-R-BODY");
    });
  });

  test("compaction drops one session's state and leaves every other session's alone", async () => {
    await withTempDir(async (repoRoot) => {
      await seedPackage(repoRoot, PACKAGE);
      await seedRule(repoRoot, "r.md", "## R\n\nRULE-R-BODY\n");
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });
      const first = handlerContext({ role: "wf-implementer", sessionName: "sess-first" });
      const second = handlerContext({ role: "wf-implementer", sessionName: "sess-second" });

      expect((await callBeforeTool(set, read(A_PATH), first)).kind).toBe("nudge");
      expect((await callBeforeTool(set, read(A_PATH), second)).kind).toBe("nudge");

      await callBeforeCompaction(set, beforeCompactionPayload(), first);

      expect((await callBeforeTool(set, read(A_PATH), first)).kind).toBe("nudge");
      expect(await callBeforeTool(set, read(A_PATH), second)).toEqual({ kind: "allow" });
    });
  });

  test("the reset returns no patch, on any payload", async () => {
    await withTempDir(async (repoRoot) => {
      const set = createRuleDeliveryHandlers({ repoRoot, overrideMode: "merge" });

      expect(
        await callBeforeCompaction(
          set,
          { reason: "overflow", toSummarize: [], estimatedTokens: 250_000 },
          handlerContext({ sessionName: "sess-overflow" }),
        ),
      ).toBeUndefined();
    });
  });
});
