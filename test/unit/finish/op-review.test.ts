/**
 * The phase-parameterised finish review operation — `src/finish/operations/review-op.ts`.
 * Modeled on `test/unit/operations/acceptance-fix.test.ts`: op shape, then
 * `build`/`parse` driven directly with a `{ packageView, config }` context
 * built from `makeTestRuntime()`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import type { FinishReviewInput } from "@/finish";
import { finishReviewOp } from "@/finish";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime, withTempDir } from "@test/helpers";

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
    expect(finishReviewOp.timeoutMs?.(SPEC_INPUT, ctx)).toBeUndefined();
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
  test("attaches the gaps auditGaps reports, against a temp workdir", async () => {
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
