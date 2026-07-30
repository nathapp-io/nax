/**
 * runFixCycle — UNRESOLVED handling and strategy retirement.
 *
 * Split out of cycle.test.ts under the 800-line test cap. Covers the two issues
 * that shaped this behaviour:
 *   - #1369 — one strategy gives up while a co-run sibling keeps working; the
 *     sibling's progress must be measured, not discarded.
 *   - #1384 — retirement is scoped to the findings a strategy actually declined, so
 *     an unrelated finding routed only to that strategy is not orphaned.
 *
 * Exercises `createDeclineLedger` (src/findings/cycle-retirement.ts) through
 * `runFixCycle`, which is the only thing that drives it.
 */

import { describe, expect, test } from "bun:test";
import type { CallOpFn } from "@/findings/cycle";
import { runFixCycle } from "@/findings";
import type { Finding } from "@/findings";
import { lintA, lintB, makeCallOpMock, makeCtx, makeCycle, makeFinding, makeStrategy, typecheckC } from "./_cycle-fixtures";

// ─── runFixCycle — partial give-up in a co-run group (#1369) ─────────────────

describe("runFixCycle — one strategy gives up, a co-run sibling does not", () => {
  /** Strategy that reports UNRESOLVED; stands in for autofix-implementer. */
  const givesUp = (name: string) =>
    makeStrategy({
      name,
      coRun: "co-run-sequential",
      maxAttempts: 3,
      extractApplied: () => ({ summary: "", unresolved: "cannot edit test files" }),
    });
  /** Strategy that completes normally; stands in for autofix-test-writer. */
  const succeeds = (name: string) => makeStrategy({ name, coRun: "co-run-sequential", maxAttempts: 3 });

  test("validates instead of abandoning the group, so the sibling's fix is measured", async () => {
    let validateCalled = false;
    const cycle = makeCycle([lintA], [givesUp("implementer"), succeeds("test-writer")], async () => {
      validateCalled = true;
      return []; // the sibling's fix resolved the finding
    });
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(validateCalled).toBe(true);
    expect(r.exitReason).toBe("resolved");
    expect(r.finalFindings).toEqual([]);
  });

  test("carries the UNRESOLVED reason onto the later exit the cycle actually reaches", async () => {
    // Each strategy owns a different finding. The implementer gives up on its
    // one; the test-writer clears its own. Validation leaves only the abandoned
    // finding, and its sole claimer is now retired — so the cycle exits
    // `no-strategy` rather than `agent-gave-up`, and the diagnostic text has to
    // survive that switch or the give-up becomes invisible.
    const implementer = makeStrategy({
      name: "implementer",
      coRun: "co-run-sequential",
      appliesTo: (f) => f.source === "lint",
      extractApplied: () => ({ summary: "", unresolved: "cannot edit test files" }),
    });
    const testWriter = makeStrategy({
      name: "test-writer",
      coRun: "co-run-sequential",
      appliesTo: (f) => f.source === "typecheck",
    });
    const cycle = makeCycle([lintA, typecheckC], [implementer, testWriter], async () => [lintA]);
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(r.exitReason).toBe("no-strategy");
    expect(r.unresolvedDetail).toBe("cannot edit test files");
    expect(r.finalFindings).toEqual([lintA]);
  });

  test("does not re-dispatch a strategy that already gave up while a sibling keeps working", async () => {
    const dispatched: string[] = [];
    const track = (name: string, unresolved?: string) =>
      makeStrategy({
        name,
        coRun: "co-run-sequential",
        maxAttempts: 3,
        extractApplied: () => {
          dispatched.push(name);
          return { summary: "", ...(unresolved ? { unresolved } : {}) };
        },
      });
    // Findings never clear, so the cycle keeps iterating until the caps bind.
    // The sibling must be retried; the strategy that gave up must not be.
    const cycle = makeCycle(
      [lintA],
      [track("implementer", "cannot edit test files"), track("test-writer")],
      async () => [lintA],
    );
    await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp: makeCallOpMock() as unknown as CallOpFn });
    expect(dispatched.filter((n) => n === "implementer")).toHaveLength(1);
    expect(dispatched.filter((n) => n === "test-writer").length).toBeGreaterThan(1);
  });

  test("exits agent-gave-up without validating when every strategy in the group gives up", async () => {
    let validateCalled = false;
    const cycle = makeCycle([lintA], [givesUp("implementer"), givesUp("test-writer")], async () => {
      validateCalled = true;
      return [];
    });
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(validateCalled).toBe(false);
    expect(r.exitReason).toBe("agent-gave-up");
  });
});

// ─── runFixCycle — retirement is per-finding, not per-cycle (#1384) ───────────
//
// UNRESOLVED is a per-finding signal: the agent said "I cannot fix THIS", not "I
// cannot fix anything in this story". Retiring the strategy for the whole cycle
// meant a later, unrelated finding routed only to that strategy exited the cycle
// `no-strategy`, and the caller discarded the whole pass — even when the
// outstanding fix was trivial. Observed on otel-telemetry-expansion US-006, where
// a one-line barrel export was orphaned by a refusal about a scoping decision.
//
// The dispatch hands a strategy EVERY finding it claims in one call and gets back
// one verdict, so the declined unit is that input batch.

describe("runFixCycle — per-finding retirement", () => {
  /** Records each dispatch's strategy name; optionally answers UNRESOLVED. */
  function tracked(
    name: string,
    dispatched: string[],
    opts: { unresolved?: string; appliesTo?: (f: Finding) => boolean } = {},
  ) {
    return makeStrategy({
      name,
      coRun: "co-run-sequential",
      maxAttempts: 3,
      ...(opts.appliesTo ? { appliesTo: opts.appliesTo } : {}),
      extractApplied: () => {
        dispatched.push(name);
        return { summary: "", ...(opts.unresolved ? { unresolved: opts.unresolved } : {}) };
      },
    });
  }

  test("a strategy that declined finding A is still dispatched for a NEW finding B it claims", async () => {
    // The exact #1384 shape. A co-run sibling is required, and not incidentally: when
    // EVERY strategy in the group gives up, the cycle exits before validating — nothing
    // touched the tree, so re-validating would burn a full suite run to learn nothing.
    // On US-006 the sibling (autofix-test-writer) did commit, which is what surfaced the
    // later finding the retired implementer was the only claimer of.
    const dispatched: string[] = [];
    const implementer = tracked("implementer", dispatched, {
      unresolved: "needs a scoping decision",
      appliesTo: (f) => f.source === "lint",
    });
    const testWriter = tracked("test-writer", dispatched, { appliesTo: (f) => f.source === "typecheck" });
    // Round 1 clears both seeded findings but surfaces lintB — unrelated to the refusal,
    // and claimed only by the implementer.
    const cycle = makeCycle([lintA, typecheckC], [implementer, testWriter], async () => [lintB]);
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    // Before #1384 this was 1: the implementer was retired cycle-wide and lintB orphaned,
    // exiting `no-strategy` so the caller discarded the sibling's work too.
    expect(dispatched.filter((n) => n === "implementer").length).toBeGreaterThan(1);
    expect(r.exitReason).not.toBe("no-strategy");
  });

  test("a strategy is NOT re-dispatched while every finding it claims is already declined", async () => {
    // Termination guard: the declined set only grows, so a strategy facing the same
    // batch must not be re-asked (the #1369 behaviour this must preserve).
    const dispatched: string[] = [];
    const implementer = tracked("implementer", dispatched, { unresolved: "cannot fix" });
    const cycle = makeCycle([lintA], [implementer], async () => [lintA]);
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(dispatched).toEqual(["implementer"]);
    expect(r.exitReason).toBe("agent-gave-up");
  });

  test("declining one finding does not retire the strategy for a sibling's findings", async () => {
    // Retirement is scoped to (strategy, finding). Another strategy claiming the
    // same finding is unaffected — and vice versa.
    const dispatched: string[] = [];
    const implementer = tracked("implementer", dispatched, {
      unresolved: "cannot fix lint",
      appliesTo: (f) => f.source === "lint",
    });
    const testWriter = tracked("test-writer", dispatched, { appliesTo: (f) => f.source === "typecheck" });
    const cycle = makeCycle([lintA, typecheckC], [implementer, testWriter], async () => [lintA, typecheckC]);
    await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp: makeCallOpMock() as unknown as CallOpFn });
    expect(dispatched.filter((n) => n === "implementer")).toHaveLength(1);
    expect(dispatched.filter((n) => n === "test-writer").length).toBeGreaterThan(1);
  });

  test("no-strategy now means a genuine routing gap, not a retired strategy", async () => {
    // Nothing claims the typecheck finding at all.
    const dispatched: string[] = [];
    const implementer = tracked("implementer", dispatched, { appliesTo: (f) => f.source === "lint" });
    const cycle = makeCycle([lintA], [implementer], async () => [typecheckC]);
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(r.exitReason).toBe("no-strategy");
    expect(r.finalFindings).toEqual([typecheckC]);
  });

  test("re-emitted-with-rephrased-message counts as a new finding — accepted drift, bounded by maxAttempts", async () => {
    // `findingKey` includes `message`, so an LLM rewording mints a new key and the
    // strategy becomes dispatchable again for what is substantively the same finding.
    // Documented as accepted: the drift is in the "try again" direction and the
    // per-strategy cap still binds. Mechanical producers have stable messages.
    const dispatched: string[] = [];
    const implementer = tracked("implementer", dispatched, {
      unresolved: "cannot fix",
      appliesTo: (f) => f.source === "lint",
    });
    // Sibling keeps the cycle alive past the all-gave-up early exit, as above.
    const testWriter = tracked("test-writer", dispatched, { appliesTo: (f) => f.source === "typecheck" });
    let round = 0;
    const cycle = makeCycle([lintA, typecheckC], [implementer, testWriter], async () => {
      round++;
      return [
        makeFinding({ source: "lint", message: `unused var (attempt ${round})`, file: "src/a.ts", line: 1 }),
        typecheckC,
      ];
    });
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    // Re-dispatched because the key changed — but the per-strategy cap still binds.
    expect(dispatched.filter((n) => n === "implementer")).toHaveLength(3);
    expect(r.exitReason).toBe("max-attempts-per-strategy");
  });
});
