/**
 * US-004 — `gateOutputs` exposes `ran` so the PR body can render the
 * green-gate list (`Gates: lint, typecheck, test`) at `open_pr`.
 *
 * The shape widening here is a one-shot read of `ctx.outputs.quality_gates`.
 * The node that writes that output is `flows/nax-finish/nax-finish.flow.ts`
 * (quality_gates), which already emits `ran: string[]` alongside `failing`
 * via `QualityGateOutcome`; only the reader was lagging.
 */
import { describe, expect, test } from "bun:test";
import { gateOutputs } from "@flows/nax-finish/flow-ctx";

describe("gateOutputs (US-004 ran exposure)", () => {
  test("US-004 returns the ran array from quality_gates output", () => {
    const outputs = { quality_gates: { ran: ["lint", "typecheck", "test"], failing: [] } };
    // Cast to the OutputsCtx parameter shape the function accepts; we then
    // assert on the widened return type. If `ran` is dropped from the return
    // type, the assignment here is a TS error — caught by typecheck rather
    // than at runtime, since the runtime object does carry `ran` regardless.
    const out = gateOutputs({ outputs } as Parameters<typeof gateOutputs>[0]);
    expect(out.ran).toEqual(["lint", "typecheck", "test"]);
  });

  test("US-004 still returns failing alongside ran — the widening is additive, not replacing", () => {
    const outputs = { quality_gates: { ran: ["lint", "typecheck"], failing: ["lint"] } };
    const out = gateOutputs({ outputs } as Parameters<typeof gateOutputs>[0]);
    expect(out.failing).toEqual(["lint"]);
    expect(out.ran).toEqual(["lint", "typecheck"]);
  });

  test("US-004 returns an empty object when quality_gates has not produced any output yet", () => {
    const out = gateOutputs({ outputs: {} } as Parameters<typeof gateOutputs>[0]);
    expect(out.ran).toBeUndefined();
    expect(out.failing).toBeUndefined();
  });
});
