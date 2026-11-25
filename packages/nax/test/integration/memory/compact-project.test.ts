/**
 * compact-project.test.ts — what one compaction puts on the wire, and what it
 * reports once the mirror has taken the plan.
 *
 * Covers AC-6, AC-7, AC-8 and AC-19: the op is `memoryCompactOp` and it is
 * dispatched exactly once; the input carries the candidate notes, the repository
 * facts, the fill the index shows and the threshold as a percentage; and the
 * applied outcome's `fillAfter` is the index re-rendered after the apply rather
 * than a projection of the one before it.
 *
 * The op is stubbed through `_compactProjectDeps.callOp`, so the call itself is
 * recorded while the op it receives is the real one — no case makes a billed
 * model call. The rest of the flow is the harness's host double and its two
 * recorded seams.
 */

import { describe, expect, test } from "bun:test";
import {
  COMPACT_CANDIDATES,
  COMPACT_FACTS,
  COMPACT_INDEX_AFTER,
  COMPACT_PLAN,
  COMPACT_PREVIEW,
  COMPACT_RESULT,
  makeCompactProjectHarness,
  makeNaxConfig,
  withDepsRestore,
} from "@test/helpers";
import { _compactProjectDeps, compactProjectMemory } from "@/memory";
import { memoryCompactOp } from "@/operations";

describe("compactProjectMemory dispatch", () => {
  withDepsRestore(_compactProjectDeps);

  // AC-6
  test("dispatches memoryCompactOp once, with the candidates as notes and the configured model", async () => {
    const h = makeCompactProjectHarness({
      config: makeNaxConfig({ memory: { compact: { model: "powerful" } } }),
    });

    await compactProjectMemory(h.input);

    expect(h.calls.dispatch).toHaveLength(1);
    expect(h.calls.dispatch[0]?.op).toBe(memoryCompactOp);
    expect(h.calls.dispatch[0]?.input).toMatchObject({ notes: COMPACT_CANDIDATES, model: "powerful" });
  });

  // AC-7
  test("carries the repository facts into the dispatch", async () => {
    const h = makeCompactProjectHarness();

    await compactProjectMemory(h.input);

    expect(h.calls.dispatch[0]?.input).toMatchObject({
      features: COMPACT_FACTS.features,
      branches: COMPACT_FACTS.branches,
      commits: COMPACT_FACTS.commits,
    });
  });

  // AC-8
  test("carries the fill the index renders and the rounded threshold target", async () => {
    const h = makeCompactProjectHarness();

    await compactProjectMemory(h.input);

    // A 500-byte index under the config's 1000-byte cap, and a 0.65 threshold.
    expect(h.calls.dispatch[0]?.input).toMatchObject({ fillPercent: 50, targetPercent: 65 });
  });

  // AC-19
  test("answers applied with the result and the fill the index shows after the apply", async () => {
    const h = makeCompactProjectHarness({ indexAfterApply: COMPACT_INDEX_AFTER });

    const outcome = await compactProjectMemory(h.input);

    expect(outcome).toEqual({
      kind: "applied",
      preview: COMPACT_PREVIEW,
      result: COMPACT_RESULT,
      fillAfter: 0.02,
    });
    // One render before the apply, one after: the second is where fillAfter comes from.
    expect(h.calls.renders).toBe(2);
    expect(h.calls.apply).toEqual([{ plan: COMPACT_PLAN, model: "balanced", fillBefore: 0.5 }]);
  });
});
