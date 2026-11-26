/**
 * Plan validation: every reason a compaction plan may not be applied, collected at once.
 *
 * The validator is the one gate between what a model proposed and what an apply writes, so
 * its answer is a list, not a verdict: a plan that is wrong in three ways must be told all
 * three, because the model is asked to fix it in one revision. The checks are the mirror's
 * own rules restated — a note a plan acts on must be a candidate, a slug may be touched
 * once, a merge folds two or more notes of one type, a target may not shadow a slug that
 * already exists, and the note it writes and the reason a retire carries pass the same
 * write validation a direct save does.
 */
import { describe, expect, test } from "bun:test";
import {
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_SLUG_RE,
  type MemoryNote,
  validateMemoryNoteWrite,
} from "@nathapp/nax-agent";
import type {
  MemoryCompactionMerge,
  MemoryCompactionPlan,
  MemoryCompactionPlanCheck,
} from "@nathapp/nax-agent/internal";
import * as internal from "@nathapp/nax-agent/internal";
import * as memory from "#src/memory/index";

const UPDATED_AT = "2026-11-02T08:11:00.000Z";

/** `ghp_` plus 20 alphanumerics: a GitHub personal access token the secret scan reports. */
const GITHUB_TOKEN = `ghp_${"a".repeat(20)}`;

/** One candidate note; every assertion starts from this shape. */
function note(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "mem_01J9X2",
    slug: "replay-budget-a",
    type: "project",
    scope: "project",
    description: "replay budget stays 2,048 MiB",
    source: "nax-chat",
    updatedAt: UPDATED_AT,
    status: "active",
    body: "The replay budget stays at 2,048 MiB.",
    ...overrides,
  };
}

/** The candidates the plans below draw on: four project notes and one reference note. */
function candidates(): readonly MemoryNote[] {
  return [
    note({ slug: "replay-budget-a" }),
    note({ slug: "replay-budget-b" }),
    note({ slug: "stale-story-14", description: "the retry loop changed in story 14" }),
    note({ slug: "unrelated" }),
    note({ slug: "replay-reference", type: "reference", description: "the replay budget lives in replay.ts" }),
  ];
}

/** A merge of two project notes into a third slug, with the fields each test varies. */
function merge(overrides: Partial<MemoryCompactionMerge> = {}): MemoryCompactionMerge {
  return {
    from: ["replay-budget-a", "replay-budget-b"],
    into: {
      slug: "replay-budget",
      type: "project",
      description: "replay budget stays 2,048 MiB",
      body: "The replay budget stays at 2,048 MiB.",
    },
    ...overrides,
  };
}

/** The plan every test narrows from: one retire and one two-source merge, both valid. */
function validPlan(): MemoryCompactionPlan {
  return {
    retire: [{ slug: "stale-story-14", reason: "story 14 shipped and the loop changed" }],
    merge: [merge()],
  };
}

/** The reasons a check carries, or none when it accepted the plan. */
function reasonsOf(check: MemoryCompactionPlanCheck): readonly string[] {
  return check.ok ? [] : check.reasons;
}

describe("validateMemoryCompactionPlan: the plan as a whole", () => {
  test("AC-1: accepts a plan with one valid retire and one valid two-source merge", () => {
    const check = memory.validateMemoryCompactionPlan(validPlan(), candidates(), new Set<string>());

    expect(check).toEqual({ ok: true });
  });

  test("AC-2: refuses a plan that retires nothing and merges nothing", () => {
    const check = memory.validateMemoryCompactionPlan({ retire: [], merge: [] }, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("changes nothing");
  });
});

describe("validateMemoryCompactionPlan: notes a plan may act on", () => {
  test("AC-3: refuses a retire of a slug that is not a candidate, naming it", () => {
    const plan: MemoryCompactionPlan = {
      retire: [{ slug: "ghost-note", reason: "the note describes a loop that is gone" }],
      merge: [],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("ghost-note");
  });

  test("AC-4: refuses a merge whose from names a slug that is not a candidate, naming it", () => {
    const plan: MemoryCompactionPlan = { retire: [], merge: [merge({ from: ["replay-budget-a", "ghost-note"] })] };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("ghost-note");
  });

  test("AC-5: refuses a slug that is both retired and a merge source, naming it", () => {
    const plan: MemoryCompactionPlan = {
      retire: [{ slug: "replay-budget-a", reason: "the two notes say the same thing" }],
      merge: [merge({ from: ["replay-budget-a", "replay-budget-b"] })],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("replay-budget-a");
  });

  test("AC-6: refuses two merges that use the same into.slug, naming the target", () => {
    const plan: MemoryCompactionPlan = {
      retire: [],
      merge: [
        merge(),
        merge({ from: ["stale-story-14", "unrelated"], into: { ...merge().into, slug: "replay-budget" } }),
      ],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("replay-budget");
  });
});

describe("validateMemoryCompactionPlan: merge sources", () => {
  test("AC-7: refuses a merge with exactly one from slug, naming the target", () => {
    const plan: MemoryCompactionPlan = {
      retire: [],
      merge: [{ ...merge({ from: ["replay-budget-a"] }), into: { ...merge().into, slug: "budget-consolidated" } }],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("budget-consolidated");
    expect(reasonsOf(check)[0]).not.toContain("replay-budget-a");
  });

  test("AC-8: refuses a merge whose sources are one project and one reference note, naming the target", () => {
    const plan: MemoryCompactionPlan = {
      retire: [],
      merge: [
        {
          ...merge({ from: ["replay-budget-a", "replay-reference"] }),
          into: { ...merge().into, slug: "budget-consolidated" },
        },
      ],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("budget-consolidated");
    expect(reasonsOf(check)[0]).toContain("different types");
  });

  test("AC-9: refuses a merge whose into.type is reference but whose sources are project notes, naming the target", () => {
    const plan: MemoryCompactionPlan = {
      retire: [],
      merge: [{ ...merge(), into: { ...merge().into, slug: "budget-consolidated", type: "reference" } }],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("budget-consolidated");
    expect(reasonsOf(check)[0]).toContain('"reference"');
  });
});

describe("validateMemoryCompactionPlan: merge targets", () => {
  test("AC-10: refuses a target slug that already exists and is not one of its own sources", () => {
    const plan: MemoryCompactionPlan = {
      retire: [],
      merge: [{ ...merge(), into: { ...merge().into, slug: "budget-consolidated" } }],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set(["budget-consolidated"]));

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain("budget-consolidated");
    expect(reasonsOf(check)[0]).not.toContain("replay-budget-a");
  });

  test("AC-11: accepts a target slug that is one of the merge's own from slugs", () => {
    const plan: MemoryCompactionPlan = {
      retire: [],
      merge: [merge({ into: { ...merge().into, slug: "replay-budget-a" } })],
    };
    const existing = new Set(candidates().map((candidate) => candidate.slug));

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), existing);

    expect(check).toEqual({ ok: true });
  });
});

describe("validateMemoryCompactionPlan: the note a merge writes", () => {
  /** The refusal `validateMemoryNoteWrite` answers for the merge target, when there is one. */
  function writeRefusalReason(into: MemoryCompactionMerge["into"]): string {
    const refusal = validateMemoryNoteWrite({ ...into, scope: "project" }, memory.MEMORY_COMPACTION_SOURCE);
    if (refusal === null) throw new Error("the merge target was expected to fail validateMemoryNoteWrite");
    return refusal.reason;
  }

  test("AC-12: refuses a merge whose description is 201 characters long, with the write's own reason", () => {
    const into = { ...merge().into, description: "d".repeat(MEMORY_DESCRIPTION_MAX_CHARS + 1) };

    const check = memory.validateMemoryCompactionPlan(
      { retire: [], merge: [merge({ into })] },
      candidates(),
      new Set<string>(),
    );

    expect(MEMORY_DESCRIPTION_MAX_CHARS + 1).toBe(201);
    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain(writeRefusalReason(into));
  });

  test("AC-13: refuses a merge whose body carries a secret, with the write's own reason", () => {
    const into = { ...merge().into, body: `rotate the token ${GITHUB_TOKEN} in replay.ts` };

    const check = memory.validateMemoryCompactionPlan(
      { retire: [], merge: [merge({ into })] },
      candidates(),
      new Set<string>(),
    );

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain(writeRefusalReason(into));
  });

  test("AC-14: refuses a merge whose slug does not match MEMORY_SLUG_RE, with the write's own reason", () => {
    const into = { ...merge().into, slug: "Budget Consolidated" };

    const check = memory.validateMemoryCompactionPlan(
      { retire: [], merge: [merge({ into })] },
      candidates(),
      new Set<string>(),
    );

    expect(MEMORY_SLUG_RE.test(into.slug)).toBe(false);
    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain(writeRefusalReason(into));
  });
});

describe("validateMemoryCompactionPlan: retire reasons", () => {
  /** A plan that retires one candidate with `reason`, and merges nothing. */
  function retirePlan(reason: string): MemoryCompactionPlan {
    return { retire: [{ slug: "stale-story-14", reason }], merge: [] };
  }

  /** The refusal `forgetReasonRefusal` answers for `reason`, which the validator must repeat. */
  function forgetRefusalReason(reason: string): string {
    const refusal = memory.forgetReasonRefusal(reason);
    if (refusal === null) throw new Error("the retire reason was expected to fail forgetReasonRefusal");
    return refusal.reason;
  }

  test("AC-15: refuses a retire reason that spans two lines, with forgetReasonRefusal's reason", () => {
    const reason = "story 14 shipped\nand the retry loop changed";

    const check = memory.validateMemoryCompactionPlan(retirePlan(reason), candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain(forgetRefusalReason(reason));
  });

  test("AC-16: refuses an empty retire reason, with forgetReasonRefusal's reason", () => {
    const check = memory.validateMemoryCompactionPlan(retirePlan(""), candidates(), new Set<string>());

    expect(check.ok).toBe(false);
    expect(reasonsOf(check)).toHaveLength(1);
    expect(reasonsOf(check)[0]).toContain(forgetRefusalReason(""));
  });
});

describe("validateMemoryCompactionPlan: every reason at once", () => {
  test("AC-17: answers two reasons for a plan with a non-candidate retire and a one-source merge", () => {
    const plan: MemoryCompactionPlan = {
      retire: [{ slug: "ghost-note", reason: "the note describes a loop that is gone" }],
      merge: [{ ...merge({ from: ["replay-budget-a"] }), into: { ...merge().into, slug: "budget-consolidated" } }],
    };

    const check = memory.validateMemoryCompactionPlan(plan, candidates(), new Set<string>());

    const reasons = reasonsOf(check);
    expect(check.ok).toBe(false);
    expect(reasons).toHaveLength(2);
    expect(reasons.some((reason) => reason.includes("ghost-note"))).toBe(true);
    expect(reasons.some((reason) => reason.includes("budget-consolidated"))).toBe(true);
  });
});

describe("./internal export", () => {
  test("AC-18: the validator is importable from @nathapp/nax-agent/internal", () => {
    expect(internal.validateMemoryCompactionPlan).toBe(memory.validateMemoryCompactionPlan);
    expect(internal.validateMemoryCompactionPlan({ retire: [], merge: [] }, [], new Set<string>())).toEqual({
      ok: false,
      reasons: [expect.stringContaining("changes nothing")],
    });
  });
});
