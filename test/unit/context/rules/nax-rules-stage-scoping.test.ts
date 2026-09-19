/**
 * Stage scoping of THIS repo's own .nax/rules/*.md.
 *
 * `stages:` frontmatter is the role axis: StaticRulesProvider admits a rule to
 * a context-engine stage only when the stage is listed (ruleMatchesStage,
 * src/context/engine/providers/static-rules.ts). It is FAIL-OPEN — a rule with
 * no `stages:` key is universal — so this file asserts both directions:
 * rules that must NOT reach a stage, and rules that must.
 *
 * Why the assertion is worth having: the fresh TDD implementer session
 * (op `implementer` -> stage `tdd-implementer`, phase-stage-map.ts) is
 * forbidden from writing test files, yet the four test-authoring rules below
 * listed that stage and made up ~28% of its prompt. Re-adding the stage is a
 * one-line edit in a file nobody reads twice; this test is what notices.
 *
 * Deliberately reads the real files rather than a fixture: the artifact under
 * test IS this repo's frontmatter, so a mocked loader would assert nothing.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { CanonicalRule } from "@/context";
import { loadCanonicalRules } from "@/context";

// test/unit/context/rules/<this file> -> repo root is four levels up.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** The fresh TDD implementer session's stage. Rectification turns use `rectify`. */
const IMPLEMENTER_STAGE = "tdd-implementer";
const TEST_WRITER_STAGE = "tdd-test-writer";
const RECTIFY_STAGE = "rectify";

/** Rules that exist for whoever AUTHORS test files. */
const TEST_AUTHORING_RULES = [
  "test-ratchets.md",
  "test-architecture.md",
  "test-helpers.md",
  "test-writing.md",
] as const;

/**
 * Test-related rules the implementer legitimately needs:
 *  - testing-commands: it runs scoped tests every cycle (timeout wrapper, scoped recipe).
 *  - forbidden-patterns-tests: its three narrow test-edit exceptions can violate these.
 */
const IMPLEMENTER_TEST_RULES = ["testing-commands.md", "forbidden-patterns-tests.md"] as const;

let cached: CanonicalRule[] | undefined;
async function rules(): Promise<CanonicalRule[]> {
  cached ??= await loadCanonicalRules(REPO_ROOT);
  return cached;
}

async function ruleNamed(fileName: string): Promise<CanonicalRule> {
  const found = (await rules()).find((r) => r.fileName === fileName);
  if (!found) throw new Error(`.nax/rules/${fileName} not found — was it renamed or deleted?`);
  return found;
}

describe("nax .nax/rules — the loader sees a usable rule set", () => {
  test("the canonical store loads and every rule declares stages", async () => {
    const all = await rules();
    expect(all.length).toBeGreaterThan(0);

    // `stages:` is fail-open, so a rule that drops the key silently becomes
    // universal — which is the failure mode this whole file guards against.
    const universal = all.filter((r) => r.stages === undefined || r.stages.length === 0);
    expect(universal.map((r) => r.fileName)).toEqual([]);
  });
});

describe("nax .nax/rules — test-authoring rules are scoped to authoring stages", () => {
  for (const fileName of TEST_AUTHORING_RULES) {
    test(`${fileName} does NOT reach the fresh implementer session`, async () => {
      const rule = await ruleNamed(fileName);
      expect(rule.stages).toBeDefined();
      expect(rule.stages, `${fileName} must not list ${IMPLEMENTER_STAGE}`).not.toContain(IMPLEMENTER_STAGE);
    });

    test(`${fileName} still reaches the test-writer`, async () => {
      const rule = await ruleNamed(fileName);
      expect(rule.stages, `${fileName} must keep ${TEST_WRITER_STAGE}`).toContain(TEST_WRITER_STAGE);
    });

    test(`${fileName} still reaches rectification`, async () => {
      // Rectification turns dispatch the `implementer` op onto the `rectify`
      // stage (RECTIFICATION_STAGE_MAP is consulted before the three-session
      // branch), and that is the implementer context that may edit tests under
      // the three narrow exceptions. Narrowing must not reach it.
      const rule = await ruleNamed(fileName);
      expect(rule.stages, `${fileName} must keep ${RECTIFY_STAGE}`).toContain(RECTIFY_STAGE);
    });
  }
});

describe("nax .nax/rules — the implementer keeps the test rules it needs", () => {
  for (const fileName of IMPLEMENTER_TEST_RULES) {
    test(`${fileName} still reaches the fresh implementer session`, async () => {
      const rule = await ruleNamed(fileName);
      expect(rule.stages, `${fileName} must keep ${IMPLEMENTER_STAGE}`).toContain(IMPLEMENTER_STAGE);
    });
  }
});

describe("nax .nax/rules — source rules stay off the test-writer", () => {
  test("forbidden-patterns-source.md does not reach the test-writer", async () => {
    // The mirror image of the narrowing above, and the observation that proved
    // the `stages:` axis works at all: this rule is in the implementer prompt
    // and absent from the test-writer's.
    const rule = await ruleNamed("forbidden-patterns-source.md");
    expect(rule.stages).not.toContain(TEST_WRITER_STAGE);
    expect(rule.stages).toContain(IMPLEMENTER_STAGE);
  });
});
