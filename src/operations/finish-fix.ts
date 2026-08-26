/**
 * The phase-parameterised finish fix operation.
 *
 * One `RunOperation` drives all four fix phases (`gate`, `acceptance`,
 * `spec`, `quality`), since `buildFixPrompt` is already phase-agnostic (the
 * caller supplies `phase` on the input). Sibling of `finish-review-op.ts` —
 * same `session`/`config`/`model`/`timeoutMs` shape, same `build`
 * `ComposeInput` pattern — but simpler in two ways documented below.
 */
import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import type { FixOutcome } from "../finish/ops";
import { buildFixPrompt, parseDispositions, validateDispositions } from "../finish/review";
import type { Finding, FinishPhase } from "../finish/types";
import type { RunOperation, RunOperationWithHooks } from "./types";

export interface FinishFixInput {
  phase: FinishPhase;
  workdir: string;
  findings?: Finding[];
  failing?: string[];
  gateOutput?: string;
  acceptanceOutput?: string;
  /** Fixer selection, resolved by the caller from config (D3.6). */
  model?: ConfiguredModel;
  timeoutMs?: number;
}

export const finishFixOp: RunOperationWithHooks<FinishFixInput, FixOutcome, FinishConfig, "verify" | "recover"> = {
  kind: "run",
  name: "finish-fix",
  stage: "rectification",
  config: finishConfigSelector,
  session: { role: "finish-fix", lifetime: "fresh" },
  model: (input) => input.model,
  // `finish.timeouts.stepMs` when set, otherwise the run's own session timeout.
  // Not left undefined: `callOp` does fall back to `execution.sessionTimeoutSeconds`
  // for run-kind ops, but that is a branch inside `callOp` that nothing pins for
  // these ops, and complete-kind ops get no such fallback at all. Resolving it
  // here makes the bound explicit and matches the acceptance ops.
  timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const content = buildFixPrompt(input.phase, {
      findings: input.findings,
      gateOutput: input.gateOutput,
      acceptanceOutput: input.acceptanceOutput,
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  /**
   * Nothing but the `## DISPOSITIONS` section is read from the reply.
   *
   * Deliberately no JSON parse tier here. The legacy flow's `parseFixVerdict`
   * carried one because it had a `route` field to compute from the reply's
   * JSON envelope; this op has no route to flip, so there is nothing for a
   * JSON tier to feed. Adding one back would let a bare `[1]` disposition
   * line — which `JSON.parse` reads as a valid one-element array — get
   * silently misrouted through the wrong parser. `parseDispositions`'s
   * text-based parsing is the only route in and stays that way.
   */
  parse(output, _input, _ctx) {
    return { dispositions: parseDispositions(output) };
  },
  // verify is the sanctioned disk-consulting hook (ADR-020 §D4). Must return
  // the op's O — `{ dispositions }` — not a bare array, or the field name is
  // lost and the value typechecks as unknown at the call site.
  async verify(parsed, input, _verifyCtx) {
    return { dispositions: await validateDispositions(input.workdir, parsed.dispositions ?? []) };
  },
  /**
   * Without this, an empty reply throws `CALL_OP_NO_OUTPUT` and discards a
   * fix that is already on disk — the fixer's real output is the working
   * tree, read independently by `commitFixes`, not the reply text.
   */
  async recover() {
    return { dispositions: [] };
  },
  // No `retry`: a fix reply carrying no `## DISPOSITIONS` section is not a
  // parse failure to re-prompt for. The fixer's real output is the working
  // tree, which `commitFixes` reads independently; re-prompting for prose the
  // machine does not depend on wastes a turn. Do not add one back.
};
