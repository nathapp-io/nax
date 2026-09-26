/**
 * US-004 — dependency builder for the non-blocking fix (NBF) keep gate.
 *
 * `ExecutionPlan.run` used to build NBF's override object inline; this module
 * owns it instead so the scoped fix review (ADR-033) can be wired in beside
 * `measureSourceDiff` without growing an already-600-line file.
 *
 * STUB (test-writer RED state): `buildNbfDeps` is declared so the acceptance
 * tests compile. It returns an empty override set — the implementer wires
 * `measureSourceDiff` (built exactly as the previous inline
 * `createMeasureSourceDiff(...)` call) plus `reviewFix` when `ctx.story` is
 * defined.
 */
import type { Finding } from "@/findings";
import type { CallContext } from "@/operations";
import type { NonBlockingFixDeps } from "../non-blocking-fix";

export function buildNbfDeps(_args: { ctx: CallContext; findings: readonly Finding[] }): Partial<NonBlockingFixDeps> {
  return {};
}
