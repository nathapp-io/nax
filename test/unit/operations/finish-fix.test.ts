import { afterEach, describe, expect, test } from "bun:test";
/**
 * The phase-parameterised finish fix operation — `src/finish/operations/fix-op.ts`.
 * Modeled on `test/unit/finish/op-review.test.ts`: op shape, then
 * `build`/`parse`/`verify` driven directly with a `{ packageView, config }`
 * context built from `makeTestRuntime()`.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestRuntime, opSelector, withTempDir } from "@test/helpers";
import type { Finding } from "@/finish";
import type { FinishFixInput } from "@/operations";
import { finishFixOp } from "@/operations";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

// `op.config` is declared as `ConfigSelector<C> | readonly (keyof NaxConfig)[]`
// on OperationBase (a union covering both selector styles); this op only ever
// uses the selector form, so the narrowing cast is safe — same pattern as
// test/unit/finish/op-review.test.ts.
function makeCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(opSelector(finishFixOp.config)) };
}

const GATE_INPUT: FinishFixInput = {
  phase: "gate",
  workdir: "/tmp/finish-fix-test",
  gateOutput: "lint failed: unused variable `x`",
};

const FINDINGS: Finding[] = [
  { severity: "HIGH", title: "Missing null check", problem: "foo() can receive null", fix: "add a guard" },
  { severity: "MEDIUM", title: "Unused import", problem: "bar.ts imports baz unused", fix: "remove the import" },
];

const SPEC_INPUT: FinishFixInput = {
  phase: "spec",
  workdir: "/tmp/finish-fix-test",
  findings: FINDINGS,
};

describe("finishFixOp shape", () => {
  test("kind, name, stage, session, and config are correct", () => {
    expect(finishFixOp.kind).toBe("run");
    expect(finishFixOp.name).toBe("finish-fix");
    expect(finishFixOp.stage).toBe("rectification");
    expect(finishFixOp.session.role).toBe("finish-fix");
    expect(finishFixOp.session.lifetime).toBe("fresh");
    expect(finishFixOp.config).toBeDefined();
  });

  test("no retry field is declared", () => {
    expect(finishFixOp.retry).toBeUndefined();
  });

  test("timeoutMs prefers the input, else execution.sessionTimeoutSeconds", () => {
    // finish.timeouts.stepMs defaults to null, so an input with no timeoutMs is
    // the common case and must still be bounded.
    const ctx = makeCtx();
    expect(finishFixOp.timeoutMs?.({ ...GATE_INPUT, timeoutMs: 4242 }, ctx)).toBe(4242);
    expect(finishFixOp.timeoutMs?.(GATE_INPUT, ctx)).toBe(ctx.config.execution.sessionTimeoutSeconds * 1000);
  });
});

describe("finishFixOp.build()", () => {
  test("gate phase includes the gate output and does not number findings", () => {
    const ctx = makeCtx();
    const result = finishFixOp.build(GATE_INPUT, ctx);
    expect(result.task.content).toContain("lint failed: unused variable `x`");
    expect(result.task.content).not.toContain("[1]");
  });

  test("spec phase numbers findings 1-based in the order given", () => {
    const ctx = makeCtx();
    const result = finishFixOp.build(SPEC_INPUT, ctx);
    const idxOne = result.task.content.indexOf("[1] [HIGH] Missing null check");
    const idxTwo = result.task.content.indexOf("[2] [MEDIUM] Unused import");
    expect(idxOne).toBeGreaterThanOrEqual(0);
    expect(idxTwo).toBeGreaterThan(idxOne);
  });
});

describe("finishFixOp.parse()", () => {
  test("reads a DISPOSITIONS section into dispositions with correct indices and fields", () => {
    const ctx = makeCtx();
    const reply = ["## DISPOSITIONS", "[1] fixed", "[2] rejected — evidence: path/to/file.ts:42"].join("\n");
    const result = finishFixOp.parse(reply, SPEC_INPUT, ctx);
    expect(result.dispositions).toEqual([
      { index: 1, disposition: "fixed" },
      { index: 2, disposition: "rejected", evidence: "path/to/file.ts:42" },
    ]);
  });

  test("reply with no DISPOSITIONS section returns an empty list without throwing", () => {
    const ctx = makeCtx();
    expect(() => finishFixOp.parse("Some narration with no verdict section.", SPEC_INPUT, ctx)).not.toThrow();
    const result = finishFixOp.parse("Some narration with no verdict section.", SPEC_INPUT, ctx);
    expect(result.dispositions).toEqual([]);
  });
});

describe("finishFixOp.verify()", () => {
  test("marks evidenceMissing on a rejection citing an absent file, leaves a present one unmarked", async () => {
    await withTempDir(async (dir) => {
      const ctx = makeCtx();
      await writeFile(join(dir, "real.ts"), "export const x = 1;\n");
      const parsed = {
        dispositions: [
          { index: 1, disposition: "rejected" as const, evidence: "real.ts:1" },
          { index: 2, disposition: "rejected" as const, evidence: "missing.ts:1" },
        ],
      };
      const result = await finishFixOp.verify!(
        parsed,
        { ...SPEC_INPUT, workdir: dir },
        {
          ...ctx,
          readFile: async () => null,
          fileExists: async () => false,
        },
      );
      expect(result?.dispositions?.[0].evidenceMissing).toBeUndefined();
      expect(result?.dispositions?.[1].evidenceMissing).toBe(true);
    });
  });
});

describe("finishFixOp.recover()", () => {
  test("returns an empty dispositions array rather than throwing", async () => {
    await withTempDir(async (dir) => {
      const ctx = makeCtx();
      const result = await finishFixOp.recover!(
        { ...SPEC_INPUT, workdir: dir },
        {
          ...ctx,
          readFile: async () => null,
          fileExists: async () => false,
        },
      );
      expect(result).toEqual({ dispositions: [] });
    });
  });
});
