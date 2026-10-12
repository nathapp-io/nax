/**
 * The phase-parameterised finish fix operation.
 *
 * One `RunOperation` drives the acceptance, gate and review fix phases, since
 * `buildFinishFixPrompt` is phase-agnostic (the caller supplies `phase` on the
 * input). Shares the `session`/`config`/`model`/`timeoutMs` shape and the
 * `build` `ComposeInput` pattern with the finish review ops, but is simpler in
 * two ways documented below.
 */

import type { ConfiguredModel } from "@/config";
import { finishConfigSelector } from "@/config";
import type { FinishConfig } from "@/config/selectors";
import { HANDOFF_MARKER, parseDispositions, parseHandoffReply, validateDispositions } from "@/finish/fix";
import { buildFinishFixPrompt, buildFinishHandoffPrompt } from "@/prompts";
import type { TurnResult } from "../agents/types";
import type { FixOutcome } from "../finish/ops";
import type { Finding, FixContinuation } from "../finish/types";
import { isInterruptedStale } from "./_interrupt";
import type { RunOperationWithHooks } from "./types";

/** Finish A: the handoff turn's own cap, independent of the stopped fix. */
export const HANDOFF_TURN_MS = 120_000;

const EMPTY_TURN: TurnResult = {
  output: "",
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  estimatedCostUsd: 0,
  internalRoundTrips: 0,
};

export interface FinishFixInput {
  phase: "acceptance" | "gate" | "review";
  workdir: string;
  findings?: Finding[];
  failing?: string[];
  gateOutput?: string;
  acceptanceOutput?: string;
  /** Fixer selection, resolved by the caller from config (D3.6). */
  model?: ConfiguredModel;
  timeoutMs?: number;
  /** Finish A: soft interrupt (phase + fixMs). The op's own signal is the run signal only. */
  interrupt?: AbortSignal;
  /** Finish A: an earlier set-aside attempt this one continues. */
  continuation?: FixContinuation;
  /** Finish B 4.2: rulings in force, rendered; and the ids a rejection may cite. */
  rulings?: string;
  rulingIds?: string[];
  /** Finish B 6.2: acceptance test files review and gate fixers may not edit unless a finding allows it. */
  acceptancePaths?: string[];
}

export const finishFixOp: RunOperationWithHooks<
  FinishFixInput,
  FixOutcome,
  FinishConfig,
  "verify" | "recover" | "hopBody"
> = {
  kind: "run",
  name: "finish-fix",
  stage: "rectification",
  config: finishConfigSelector,
  session: { role: "finish-fix", lifetime: "fresh" },
  // No GitCommit: the prompt explicitly forbids committing — "nax-finish
  // commits and pushes your edits itself" (buildFinishFixPrompt, prompts/builders/finish-review-builder.ts).
  tools: ["Read", "Glob", "Grep", "Write", "Edit", "Delete", "Git", "RunCommand", "Exec", "Bash", "RequestCapability"],
  model: (input) => input.model,
  // The finish phase supplies `finish.timeouts.reviewMs / fixMs`; `execution.sessionTimeoutSeconds` is the fallback for direct callers.
  // Not left undefined: `callOp` does fall back to `execution.sessionTimeoutSeconds`
  // for run-kind ops, but that is a branch inside `callOp` that nothing pins for
  // these ops, and complete-kind ops get no such fallback at all. Resolving it
  // here makes the bound explicit and matches the acceptance ops.
  timeoutMs: (input, ctx) => input.timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build(input, _ctx) {
    const content = buildFinishFixPrompt(input.phase, {
      findings: input.findings,
      gateOutput: input.gateOutput,
      acceptanceOutput: input.acceptanceOutput,
      rulings: input.rulings,
      acceptancePaths: input.acceptancePaths,
      ...(input.continuation ? { continuation: input.continuation } : {}),
    });
    return {
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content, overridable: false },
    };
  },
  /**
   * Finish A: one fix turn under a soft interrupt. When the interrupt fires, the turn
   * ends fail-stale ("interrupted") with the session still warm, and the same session
   * gets one more turn, capped at HANDOFF_TURN_MS, to say what it finished. The reply
   * comes back marked; it is never rethrown, so the stale-retry never re-runs a stopped
   * fix. A watchdog stall (interrupt not fired) is rethrown as before.
   */
  async hopBody(initialPrompt, ctx) {
    const { interrupt } = ctx.input;
    try {
      return await ctx.send(initialPrompt, interrupt ? { interrupt } : undefined);
    } catch (err) {
      if (!interrupt?.aborted || !isInterruptedStale(err)) throw err;
      const prompt = buildFinishHandoffPrompt(ctx.input.phase, ctx.input.findings);
      const handoff = await ctx.send(prompt, { interrupt: AbortSignal.timeout(HANDOFF_TURN_MS) }).catch(() => null);
      // Only the marked text and the cost survive: an adapterFailure on the handoff turn
      // (e.g. turnIncomplete) would make the hop fail and the same-agent retry re-run the stopped fix.
      return {
        ...EMPTY_TURN,
        output: `${HANDOFF_MARKER}\n${handoff?.output ?? ""}`,
        estimatedCostUsd: handoff?.estimatedCostUsd ?? 0,
        tokenUsage: handoff?.tokenUsage ?? EMPTY_TURN.tokenUsage,
      };
    }
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
    const handoff = parseHandoffReply(output);
    if (handoff) return { dispositions: [], ...handoff };
    return { dispositions: parseDispositions(output) };
  },
  // verify is the sanctioned disk-consulting hook (ADR-020 §D4). Must return
  // the op's O — `{ dispositions }` — not a bare array, or the field name is
  // lost and the value typechecks as unknown at the call site.
  async verify(parsed, input, _verifyCtx) {
    return {
      ...parsed,
      dispositions: await validateDispositions(input.workdir, parsed.dispositions ?? [], input.rulingIds ?? []),
    };
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
