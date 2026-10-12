import { afterEach, describe, expect, test } from "bun:test";
/**
 * The phase-parameterised finish fix operation — `src/finish/operations/fix-op.ts`.
 * Modeled on `test/unit/finish/op-review.test.ts`: op shape, then
 * `build`/`parse`/`verify` driven directly with a `{ packageView, config }`
 * context built from `makeTestRuntime()`.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTestRuntime, makeTurnResult, opSelector, withTempDir } from "@test/helpers";
import type { TurnResult } from "@/agents/types";
import { SessionFailureError } from "@/agents/types";
import type { Finding } from "@/finish";
import { HANDOFF_MARKER, parseHandoffReply } from "@/finish/fix";
import type { FinishFixInput, HopBodyContext, SendTurnOverrides } from "@/operations";
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
  phase: "review",
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
    // The finish phase supplies finish.timeouts.reviewMs / fixMs; a direct caller
    // with no timeoutMs must still be bounded by execution.sessionTimeoutSeconds.
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

  test("review phase numbers findings 1-based in the order given", () => {
    const ctx = makeCtx();
    const result = finishFixOp.build(SPEC_INPUT, ctx);
    const idxOne = result.task.content.indexOf("[1] [HIGH] Missing null check");
    const idxTwo = result.task.content.indexOf("[2] [MEDIUM] Unused import");
    expect(idxOne).toBeGreaterThanOrEqual(0);
    expect(idxTwo).toBeGreaterThan(idxOne);
  });
});

describe("finishFixOp.build() review grouping", () => {
  test("review phase prompt groups findings by source", () => {
    const built = finishFixOp.build(
      {
        phase: "review",
        workdir: "/r",
        findings: [
          { severity: "LOW", title: "S", problem: "p", fix: "f", source: "spec" },
          { severity: "LOW", title: "Q", problem: "p", fix: "f", source: "quality" },
        ],
      },
      makeCtx(),
    );
    expect(built.task.content).toContain("## Spec findings");
    expect(built.task.content).toContain("## Quality findings");
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
      const result = await finishFixOp.verify(
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
      const result = await finishFixOp.recover(
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

function stale(reason: "interrupted" | "idle-watchdog"): SessionFailureError {
  return new SessionFailureError("stale", {
    category: "availability",
    outcome: "fail-stale",
    retriable: true,
    message: "stale",
    reason,
  });
}

function hopCtx(
  input: FinishFixInput,
  send: (p: string, o?: SendTurnOverrides) => Promise<TurnResult>,
): HopBodyContext<FinishFixInput> {
  return { send, sendWithParseRetry: (p) => send(p), input };
}

describe("finishFixOp handoff (finish A)", () => {
  const hopBody = finishFixOp.hopBody;
  const base: FinishFixInput = {
    phase: "review",
    workdir: "/repo",
    findings: [{ severity: "LOW", title: "A", problem: "p", fix: "f" }],
  };

  test("a normal turn is returned unchanged, sent with the interrupt", async () => {
    const interrupt = new AbortController().signal;
    const seen: (SendTurnOverrides | undefined)[] = [];
    const turn = makeTurnResult({ output: "## DISPOSITIONS\n1. fixed" });
    const out = await hopBody(
      "fix",
      hopCtx({ ...base, interrupt }, async (_p, o) => {
        seen.push(o);
        return turn;
      }),
    );
    expect(out).toBe(turn);
    expect(seen[0]?.interrupt).toBe(interrupt);
  });

  test("an interrupted turn sends the handoff prompt on the same session and returns a marked reply", async () => {
    const interrupt = new AbortController();
    const prompts: string[] = [];
    const out = await hopBody(
      "fix",
      hopCtx({ ...base, interrupt: interrupt.signal }, async (p) => {
        prompts.push(p);
        if (prompts.length === 1) {
          interrupt.abort();
          throw stale("interrupted");
        }
        return makeTurnResult({ output: '{"findings":[]}' });
      }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Stop working");
    expect(out.output.startsWith(HANDOFF_MARKER)).toBe(true);
    expect(parseHandoffReply(out.output)).toMatchObject({ interrupted: true });
  });

  test("an incomplete handoff turn never forwards an adapterFailure", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    const out = await hopBody(
      "fix",
      hopCtx({ ...base, interrupt: interrupt.signal }, async () => {
        calls += 1;
        if (calls === 1) {
          interrupt.abort();
          throw stale("interrupted");
        }
        return makeTurnResult({
          output: "{",
          turnIncomplete: true,
          adapterFailure: {
            category: "availability",
            outcome: "fail-adapter-error",
            retriable: true,
            message: "incomplete",
          },
        });
      }),
    );
    expect(out.adapterFailure).toBeUndefined();
    expect(out.output.startsWith(HANDOFF_MARKER)).toBe(true);
  });

  test("a failing handoff turn still returns a marked, interrupted reply (no rethrow, so no stale-retry)", async () => {
    const interrupt = new AbortController();
    let calls = 0;
    const out = await hopBody(
      "fix",
      hopCtx({ ...base, interrupt: interrupt.signal }, async () => {
        calls += 1;
        if (calls === 1) interrupt.abort();
        throw stale("interrupted");
      }),
    );
    expect(out.output).toBe(`${HANDOFF_MARKER}\n`);
  });

  test("a real watchdog stall (interrupt not fired) is rethrown for the normal stale-retry", async () => {
    await expect(
      hopBody(
        "fix",
        hopCtx({ ...base, interrupt: new AbortController().signal }, async () => {
          throw stale("idle-watchdog");
        }),
      ),
    ).rejects.toBeInstanceOf(SessionFailureError);
  });
});
