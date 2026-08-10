/**
 * The two gate nodes — `acceptance` and `quality_gates`.
 *
 * Split out of `nax-finish.flow.ts`, which sits against the 600-line source
 * cap. They belong together: both answer the same question ("did anything
 * actually verify this tree?"), both enforce the same rule that **nothing ran
 * is not a pass**, and both route on the shared `MAX_FIX_ATTEMPTS` cap.
 *
 * Keeping them out of the flow file also makes them callable in tests without
 * reaching through `flow.nodes.*`.
 */
import { fixAttemptCount, inputOf, loadCtxOf } from "../flow-ctx";
import { MAX_FIX_ATTEMPTS } from "../verdict";
import { runAcceptanceGate } from "./acceptance";
import { type QualityCommands, loadQualityCommands, runQualityGates } from "./quality";

/** The slice of an acpx `FlowNodeContext` these nodes read. */
export interface GateNodeCtx {
  input: unknown;
  outputs: unknown;
  state: { steps: { nodeId: string }[] };
}

export interface AcceptanceNodeOutput {
  route: string;
  reason?: string;
  output: string;
}

export interface QualityGatesNodeOutput {
  route: string;
  reason?: string;
  ran: string[];
  failing: string[];
  output: string;
}

/** The repo's explicit opt-out, as reported by `nax features resolve`. */
function acceptanceDisabled(ctx: GateNodeCtx): boolean {
  return loadCtxOf(ctx).acceptanceStatus === "disabled";
}

/**
 * Re-run the acceptance gate, routing on the shared fix-cap rules.
 *
 * "Nothing ran" is not a pass — the same rule `quality_gates` applies to an
 * unconfigured repo. `nax features resolve` reports `groups: []` for `no-prd`,
 * for `disabled`, **and** for an `ok` resolution whose PRD grouped to no
 * package at all; it reports `exists: false` for a group whose test was
 * expected at its canonical path but never generated. Treating any of those as
 * green let the flow open a ready PR having verified nothing about the
 * feature's own contract (#1398). Only `disabled` — the repo's explicit opt-out
 * — skips cleanly.
 */
export async function acceptanceGateNode(ctx: GateNodeCtx): Promise<AcceptanceNodeOutput> {
  const i = inputOf(ctx);
  const { groups = [], acceptanceStatus } = loadCtxOf(ctx);
  if (acceptanceStatus === "disabled") {
    return { route: "proceed", output: "[acceptance] disabled in .nax/config.json — skipping" };
  }
  if (acceptanceStatus === "no-prd") {
    return {
      route: "escalate",
      reason: `Acceptance targets could not be computed (status: no-prd) — nothing was verified for "${i.feature}".`,
      output: "[acceptance] no prd.json resolved — acceptance targets unknown",
    };
  }

  const r = await runAcceptanceGate(i.workdir, groups, { timeoutMs: i.timeouts?.acceptanceMs });
  if (r.passed) {
    // A real failure below routes to the fix loop, which is more actionable;
    // the coverage hole is only reported once the runnable groups are green.
    if (r.missing.length > 0) {
      return {
        route: "escalate",
        reason: `Acceptance test never generated for: ${r.missing.join(", ")} — that package's contract is unverified.`,
        output: r.output,
      };
    }
    // Passed, nothing missing, and nothing ran: the resolver produced no group
    // to run at all. `status: "ok"` does NOT imply a target exists — it means
    // the PRD loaded — so this is the one remaining way an empty gate reports
    // green. Escalating matches what `runQualityGates` does for a repo with no
    // configured commands: an LLM fix node cannot invent the missing target.
    if (r.ran === 0) {
      return {
        route: "escalate",
        reason: `No acceptance test target resolved for "${i.feature}" (status: ${acceptanceStatus ?? "unknown"}) — nothing verified its contract.`,
        output: r.output,
      };
    }
    return { route: "proceed", output: r.output };
  }
  const attempts = fixAttemptCount(ctx, "fix_acceptance");
  if (attempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      reason: `Acceptance tests still failing after ${attempts} fix attempts.`,
      output: r.output,
    };
  }
  return { route: "fix", output: r.output };
}

/**
 * Acceptance is gate zero here, not just at the `acceptance` node.
 *
 * Both fix loops that run after it — quality review and this gate — edit code,
 * and the repo-root `test` command does not cover the feature's acceptance
 * tests: they live under `<pkg>/.nax/features/<f>/` and usually need their own
 * runner config. Re-running them here is what makes "nothing reaches open_pr
 * without the feature's own contract passing against the tree as it will ship"
 * true on every path (#1398).
 *
 * Unconditional apart from the repo's own opt-out, though the common green path
 * re-runs a gate that already passed: acceptance is the cheapest gate in the
 * pipeline, and a conditional skip derived from step history would be a check
 * that can be *wrong* — a silent false green, the failure mode this exists to
 * prevent. The `disabled` skip is not such a derivation: it is the same
 * resolver field the `acceptance` node already honours, and the two nodes
 * disagreeing about who owns the opt-out is its own bug.
 *
 * `missing` is deliberately ignored: groups are resolved once at load_ctx, so a
 * coverage hole was already escalated by the acceptance node and cannot appear
 * here.
 */
async function reverifyAcceptance(ctx: GateNodeCtx): Promise<QualityGatesNodeOutput | null> {
  if (acceptanceDisabled(ctx)) return null;
  const i = inputOf(ctx);
  const acc = await runAcceptanceGate(i.workdir, loadCtxOf(ctx).groups ?? [], {
    timeoutMs: i.timeouts?.acceptanceMs,
  });
  if (acc.passed) return null;
  // Short-circuit: the repo gates are re-run next round anyway, and skipping
  // them keeps this out of the "nothing configured" branch below, which would
  // otherwise misreport configured-but-skipped commands as absent.
  const attempts = fixAttemptCount(ctx, "fix_gate");
  const failing = ["acceptance"];
  if (attempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      reason: `A later fix broke the feature's own contract: acceptance still failing after ${attempts} fix attempts.`,
      ran: [],
      failing,
      output: acc.output,
    };
  }
  return { route: "fix", ran: [], failing, output: acc.output };
}

export async function qualityGatesNode(ctx: GateNodeCtx): Promise<QualityGatesNodeOutput> {
  const i = inputOf(ctx);

  const accFailure = await reverifyAcceptance(ctx);
  if (accFailure) return accFailure;

  const cmds: QualityCommands = await loadQualityCommands(i.workdir);
  const r = await runQualityGates(i.workdir, cmds, { timeoutMs: i.timeouts?.gateMs });
  if (r.passed) return { route: "green", ran: r.ran, failing: r.failing, output: r.output };
  // Nothing configured is not a pass — escalate immediately rather than open a
  // "ready" PR having verified nothing. An LLM fix node cannot invent the
  // repo's build/test commands.
  if (r.ran.length === 0) {
    return {
      route: "escalate",
      reason: "No quality.commands configured in .nax/config.json — nax-finish verified nothing.",
      ran: r.ran,
      failing: r.failing,
      output: r.output,
    };
  }
  const attempts = fixAttemptCount(ctx, "fix_gate");
  if (attempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      reason: `Quality gates still failing after ${attempts} fix attempts (${r.failing.join(", ")}).`,
      ran: r.ran,
      failing: r.failing,
      output: r.output,
    };
  }
  return { route: "fix", ran: r.ran, failing: r.failing, output: r.output };
}
