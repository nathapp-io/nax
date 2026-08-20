/**
 * The phase-parameterised finish review operation — `src/finish/operations/review-op.ts`.
 * Modeled on `test/unit/operations/acceptance-fix.test.ts`: op shape, then
 * `build`/`parse` driven directly with a `{ packageView, config }` context
 * built from `makeTestRuntime()`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ParseValidationError } from "@/agents/retry";
import type { RetryStrategy } from "@/agents/retry";
import type { ConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import { MAX_INCOMPLETE_ATTEMPTS, routeReview } from "@/finish";
import type { Finding } from "@/finish";
import type { FinishReviewInput } from "@/operations";
import { finishReviewOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { _gitDeps } from "@/utils/git";
import { makeTestRuntime, withDepsRestore, withTempDir } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// `op.config` is declared as `ConfigSelector<C> | readonly (keyof NaxConfig)[]`
// on OperationBase (a union covering both selector styles); this op only ever
// uses the selector form, so the narrowing cast is safe — same pattern as
// test/unit/operations/acceptance-fix.test.ts.
function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(finishReviewOp.config as ConfigSelector<FinishConfig>) };
}

const SPEC_INPUT: FinishReviewInput = {
  phase: "spec",
  base: "main",
  specPath: "docs/specs/example.md",
  workdir: "/tmp/finish-review-test",
};

const QUALITY_INPUT: FinishReviewInput = { ...SPEC_INPUT, phase: "quality" };

describe("finishReviewOp shape", () => {
  test("kind, name, stage, and session default are correct", () => {
    expect(finishReviewOp.kind).toBe("run");
    expect(finishReviewOp.name).toBe("finish-review");
    expect(finishReviewOp.stage).toBe("review");
    expect(finishReviewOp.session.lifetime).toBe("fresh");
  });

  test("session.role is a static default — per-phase role selection happens via CallContext.sessionOverride, not by resolving here", () => {
    // Both phases share the same static op-level role; the real per-phase role
    // ("finish-review-spec" vs "finish-review-quality") is supplied by the
    // CALLER via sessionOverride.role, since RunOperation.session.role cannot
    // be a per-input resolver. This assertion documents that contract so it
    // is not "fixed" into a resolver the type does not support.
    expect(finishReviewOp.session.role).toBe("finish-review-spec");
  });

  test("model and timeoutMs resolve straight from input", () => {
    const ctx = makeCtx();
    const model = { agent: "claude", model: "claude-x" };
    // op.model is declared as `ConfiguredModel | ((input, ctx) => ...)` — this
    // op only ever supplies the resolver form, so the cast is safe.
    const modelResolver = finishReviewOp.model as (
      input: FinishReviewInput,
      ctx: ReturnType<typeof makeCtx>,
    ) => unknown;
    expect(modelResolver({ ...SPEC_INPUT, model }, ctx)).toEqual(model);
    expect(finishReviewOp.timeoutMs?.({ ...SPEC_INPUT, timeoutMs: 12345 }, ctx)).toBe(12345);
  });

  test("timeoutMs falls back to execution.sessionTimeoutSeconds when finish.timeouts.stepMs is unset", () => {
    // finish.timeouts.stepMs defaults to null, so the common case is an input
    // with no timeoutMs at all. Resolving it here rather than leaving it
    // undefined keeps the bound explicit and independent of callOp's own
    // run-kind fallback -- which complete-kind ops do not get at all.
    const ctx = makeCtx();
    expect(finishReviewOp.timeoutMs?.(SPEC_INPUT, ctx)).toBe(ctx.config.execution.sessionTimeoutSeconds * 1000);
  });
});

describe("finishReviewOp.build()", () => {
  test("spec phase build contains the spec dimensions, not the quality ones", () => {
    const ctx = makeCtx();
    const result = finishReviewOp.build(SPEC_INPUT, ctx);
    expect(result.task.content).toContain("SPEC reviewer");
    expect(result.task.content).not.toContain("QUALITY reviewer");
  });

  test("quality phase build contains the quality dimensions, not the spec ones", () => {
    const ctx = makeCtx();
    const result = finishReviewOp.build(QUALITY_INPUT, ctx);
    expect(result.task.content).toContain("QUALITY reviewer");
    expect(result.task.content).not.toContain("SPEC reviewer");
  });

  test("build with `since` produces the incremental re-review prompt", () => {
    const ctx = makeCtx();
    const result = finishReviewOp.build({ ...SPEC_INPUT, since: "abc123" }, ctx);
    expect(result.task.content).toContain("continuing a review you already started");
    expect(result.task.content).toContain("git diff abc123..HEAD");
  });

  test("build without `since` produces the fresh-review prompt", () => {
    const ctx = makeCtx();
    const result = finishReviewOp.build(SPEC_INPUT, ctx);
    expect(result.task.content).not.toContain("continuing a review you already started");
    expect(result.task.content).toContain("git diff main...HEAD");
  });
});

describe("finishReviewOp.parse()", () => {
  test("well-formed reply returns findings and both saw*Section flags true", () => {
    const ctx = makeCtx();
    const reply = [
      "## TOUCHPOINTS",
      "- src/foo.ts:bar — read the implementation",
      "",
      "## WALK",
      "AC-1 Covered — implemented",
      "",
      "## FINDINGS",
      "[HIGH] Missing null check",
      "Problem: foo() can receive null",
      "Fix: add a guard",
    ].join("\n");
    const result = finishReviewOp.parse(reply, SPEC_INPUT, ctx);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe("Missing null check");
    expect(result.sawTouchpointsSection).toBe(true);
    expect(result.sawWalkSection).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  test("empty string returns an empty report rather than throwing", () => {
    const ctx = makeCtx();
    expect(() => finishReviewOp.parse("", SPEC_INPUT, ctx)).not.toThrow();
    const result = finishReviewOp.parse("", SPEC_INPUT, ctx);
    expect(result.findings).toEqual([]);
    expect(result.gaps).toEqual([]);
  });
});

describe("finishReviewOp.verify()", () => {
  // US-002: verify now consults git for the changed-file listing when the
  // audit gates the WALK on it. `_gitDeps` is a process-wide singleton, so
  // we register `withDepsRestore` at describe-top and re-assign `_gitDeps.spawn`
  // to a no-op-friendly empty-output mock in EACH test. That guarantees every
  // verify() test (and every concurrent test that reads _gitDeps.spawn) sees
  // the stub during the test and the real spawn afterwards.
  withDepsRestore(_gitDeps, ["spawn"]);

  /**
   * Install a stub that returns an empty, immediately-closed stdout/stderr
   * on every spawn so neither a real nor absent git repo is required.
   * Safe to call inside a `test()` body — withDepsRestore restores the
   * previous value in afterEach.
   */
  function installEmptySpawnStub() {
    const empty = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    _gitDeps.spawn = (() => ({
      exited: Promise.resolve(0),
      stdout: empty,
      stderr: empty,
      pid: 0,
      kill: () => {},
    })) as unknown as typeof _gitDeps.spawn; // test-ratchet-allow: as-unknown-as
  }

  test("attaches the gaps auditGaps reports, against a temp workdir", async () => {
    installEmptySpawnStub();
    await withTempDir(async (dir) => {
      const ctx = makeCtx();
      const parsed = finishReviewOp.parse("[HIGH] Some finding\nProblem: p\nFix: f", SPEC_INPUT, ctx);
      // biome-ignore lint/style/noNonNullAssertion: verify is declared on the op
      const result = await finishReviewOp.verify!(
        parsed,
        { ...SPEC_INPUT, workdir: dir },
        {
          ...ctx,
          readFile: async () => null,
          fileExists: async () => false,
        },
      );
      expect(result).not.toBeNull();
      expect(result?.gaps.length).toBeGreaterThan(0);
      expect(result?.gaps.some((g) => g.includes("TOUCHPOINTS"))).toBe(true);
    });
  });

  test("verify never returns null", async () => {
    installEmptySpawnStub();
    await withTempDir(async (dir) => {
      const ctx = makeCtx();
      const parsed = finishReviewOp.parse("No findings.", SPEC_INPUT, ctx);
      // biome-ignore lint/style/noNonNullAssertion: verify is declared on the op
      const result = await finishReviewOp.verify!(
        parsed,
        { ...SPEC_INPUT, workdir: dir },
        {
          ...ctx,
          readFile: async () => null,
          fileExists: async () => false,
        },
      );
      expect(result).not.toBeNull();
    });
  });
});

/**
 * The exhausted-retry path.
 *
 * `callOp` returns a captured `exhaustedFallback` DIRECTLY (call.ts, the
 * `!rawOutput` branch) without running `runPostParse` — the only caller of
 * `op.verify`. `verify` is what fills `gaps` via `auditGaps`, so a fallback
 * carrying `gaps: []` reaches `routeReview` as `{findings: [], gaps: []}` and
 * routes **clean**: a review that never happened, recorded as a pass, and the
 * PR promoted on the strength of it. The fallback must therefore carry its own
 * gap rather than relying on a `verify` that will not run.
 */
describe("finishReviewOp exhausted-retry fallback", () => {
  // `OperationBase.retry` is a union (preset | strategy | resolver). This op
  // declares the strategy form via makeParseRetryStrategy, so the narrowing is
  // safe — same single-cast pattern this file already uses for `op.config`.
  const strategy = finishReviewOp.retry as RetryStrategy;

  function retryCtx(lastOutput?: string) {
    return { site: "run" as const, agentName: "claude", stage: "review" as const, lastOutput };
  }

  /** `RetryDecision` is a discriminated union; `fallback` only exists on the no-retry arm. */
  function exhausted(attempt: number, lastOutput?: string): { findings: Finding[]; gaps: string[] } {
    const decision = strategy.shouldRetry(new ParseValidationError("probe"), attempt, retryCtx(lastOutput));
    if (decision.retry) throw new Error("expected the strategy to stop retrying");
    return decision.fallback as { findings: Finding[]; gaps: string[] };
  }

  test("the empty-output fallback cannot be routed as a clean review", () => {
    const fallback = exhausted(0);
    expect(fallback.findings).toEqual([]);
    // The load-bearing assertion: non-empty gaps are what stop routeReview
    // returning "clean" for a reviewer that produced nothing.
    expect(fallback.gaps.length).toBeGreaterThan(0);
  });

  test("routeReview escalates rather than passing on that fallback", () => {
    const fallback = exhausted(0);
    // Second time around (incompleteAttempts at the cap) it must escalate, not approve.
    const routed = routeReview("quality", fallback, {
      rounds: 0,
      reviewAttempts: 1,
      fixAttempts: 0,
      incompleteAttempts: MAX_INCOMPLETE_ATTEMPTS,
    });
    expect(routed.route).toBe("escalate");
  });

  test("an exhausted retry on non-empty output also carries the gap", () => {
    expect(exhausted(1, "waffle, no sections").gaps.length).toBeGreaterThan(0);
  });
});
