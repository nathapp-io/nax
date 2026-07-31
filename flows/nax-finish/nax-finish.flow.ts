/**
 * nax-finish: autonomous acpx flow driving a completed feature branch to a
 * ready PR (or an escalation) — acceptance gate, spec review, quality
 * review, quality gates, each iterated with an LLM fix-and-reverify loop.
 *
 * Reviewer agent profiles (review_spec / review_quality) are read from
 * NAX_FINISH_SPEC_PROFILE / NAX_FINISH_QUALITY_PROFILE at module load time.
 * The post-run plugin that invokes `acpx flow run` sets these env vars from
 * `finish.autoFlow.reviewers.{spec,quality}` config before spawning, since
 * this flow module reloads fresh on every `acpx flow run` invocation.
 * Unset → both fall back to acpx's `--default-agent`.
 *
 * This module is loaded by acpx, from wherever `flows/` is installed, with the
 * user's repo as cwd — so it never imports from nax's `src/` (see ./errors.ts).
 *
 * Graph shape (deviations from the design doc are deliberate and noted):
 * - `load_ctx` is an `action`, not a `compute`: it shells git + `nax features
 *   resolve` once, and its output feeds both the review prompts (specPath) and
 *   the acceptance gate (groups), so nothing resolves the feature twice.
 * - Review fixes loop: `review_* → route_* → fix_* → commit_* → (re-run
 *   acceptance | re-review) → review_*` until the reviewer comes back clean or
 *   the fix cap trips. A single-shot fix left the fixed diff unverified.
 * - Every `fix_*` node is followed by a `commit_*` node. The reviewers read
 *   `git diff <base>...HEAD`, so an uncommitted fix is invisible to the
 *   re-review: the loop re-reported findings that were already fixed and always
 *   escalated at the cap (issue #1397).
 * - `route_*` compute nodes hold the escalate/clean/fix decision so the cap is
 *   enforced deterministically rather than trusting the model's own route.
 */
import { defineFlow, extractJsonObject } from "acpx/flows";
import { buildReviewPrompt, fixPrompt } from "./review-prompts";
import {
  _contextDeps,
  buildEscalationComment,
  commitAndPush,
  commitFixes,
  detectBaseBranch,
  loadQualityCommands,
  openOrPromotePr,
  postEscalation,
  preflight,
  resolveFeature,
  runAcceptanceGate,
  runQualityGates,
  writeResult,
} from "./steps";
import type { AcceptanceGroup, FinishInput, FinishResult, ReviewVerdict } from "./types";

const inputOf = (ctx: { input: unknown }) => ctx.input as FinishInput;

/**
 * Cap on fix-and-reverify iterations, per phase, before escalating instead of
 * looping forever. acpx's flow engine has no built-in cycle guard, so without
 * this cap a stubborn failure (LLM can't fix it, or fixes something else each
 * time) hangs `acpx flow run` — and the post-run plugin awaits that subprocess.
 */
const MAX_FIX_ATTEMPTS = 3;

interface LoadCtxOutput {
  base?: string;
  specPath?: string;
  groups?: AcceptanceGroup[];
  /** `nax features resolve`'s acceptance status: "ok" | "disabled" | "no-prd". */
  acceptanceStatus?: string;
  route?: string;
}

function fixAttemptCount(ctx: { state: { steps: { nodeId: string }[] } }, fixNodeId: string): number {
  return (ctx.state.steps ?? []).filter((s) => s.nodeId === fixNodeId).length;
}

function loadCtxOf(ctx: { outputs: unknown }): LoadCtxOutput {
  return ((ctx.outputs as Record<string, LoadCtxOutput | undefined>).load_ctx ?? {}) as LoadCtxOutput;
}

/**
 * Re-run the acceptance gate, routing on the shared fix-cap rules.
 *
 * "Nothing ran" is not a pass — the same rule `quality_gates` applies to an
 * unconfigured repo. `nax features resolve` reports `groups: []` for BOTH
 * `no-prd` and `disabled`, and reports `exists: false` for a group whose test
 * was expected at its canonical path but never generated. Treating all of those
 * as green let the flow open a ready PR having verified nothing about the
 * feature's own contract (#1398). Only `disabled` — the repo's explicit opt-out
 * — skips cleanly.
 */
async function acceptanceGateNode(ctx: {
  input: unknown;
  outputs: unknown;
  state: { steps: { nodeId: string }[] };
}): Promise<{ route: string; reason?: string; output: string }> {
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
 * Turn a reviewer verdict into a deterministic route.
 *
 * `clean` (no findings) skips the fix node entirely — prompting an agent to
 * "apply the recommended fixes" for an empty finding list burns a turn and
 * invites unrequested edits.
 */
function routeReview(
  ctx: { outputs: unknown; state: { steps: { nodeId: string }[] } },
  phase: "spec" | "quality",
): { route: string; escalationReason?: string; findings: ReviewVerdict["findings"] } {
  const verdict = (ctx.outputs as Record<string, ReviewVerdict | undefined>)[`review_${phase}`];
  const findings = verdict?.findings ?? [];
  if (verdict?.route === "escalate") {
    return {
      route: "escalate",
      escalationReason: verdict.escalationReason ?? `${phase} review raised a finding needing human judgment`,
      findings,
    };
  }
  if (findings.length === 0) return { route: "clean", findings };
  const attempts = fixAttemptCount(ctx, `fix_${phase}`);
  if (attempts >= MAX_FIX_ATTEMPTS) {
    return {
      route: "escalate",
      escalationReason: `${phase} review still reporting ${findings.length} finding(s) after ${attempts} fix attempts.`,
      findings,
    };
  }
  return { route: "fix", findings };
}

/**
 * Build the `commit_<phase>` node that follows `fix_<phase>`.
 *
 * One node per phase rather than a single shared one because each returns to a
 * different successor, and acpx routes on the node id — a shared node would
 * need a switch reconstructing which fix ran from the step history.
 */
function commitFixNode(phase: "acceptance" | "spec" | "quality" | "gate") {
  return {
    nodeType: "action" as const,
    async run(ctx: { input: unknown }): Promise<{ committed: boolean }> {
      const i = inputOf(ctx);
      return commitFixes(i.workdir, `fix(${i.feature}): nax-finish ${phase} fixes`);
    },
  };
}

/** Normalise a reviewer's JSON, rewriting a findings-free `proceed` to `clean`. */
function parseVerdict(text: string): ReviewVerdict {
  const raw = extractJsonObject(text) as Partial<ReviewVerdict>;
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  const route = raw.route === "escalate" ? "escalate" : findings.length === 0 ? "clean" : "proceed";
  return { route, findings, escalationReason: raw.escalationReason };
}

export default defineFlow({
  name: "nax-finish",
  permissions: {
    requiredMode: "approve-all",
    requireExplicitGrant: true,
    reason: "This flow edits files, pushes commits, runs quality gates, comments on and opens/promotes PRs.",
  },
  startAt: "load_ctx",
  nodes: {
    load_ctx: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const base = await detectBaseBranch(i.workdir);
        const resolution = await resolveFeature(i.feature, i.workdir);
        const pf = await preflight(i.workdir, base);
        return {
          base,
          specPath: resolution.specPath,
          acceptanceStatus: resolution.acceptanceStatus,
          groups: resolution.groups,
          commitsAhead: pf.commitsAhead,
          route: pf.route,
        };
      },
    },
    acceptance: {
      nodeType: "action",
      run: acceptanceGateNode,
    },
    fix_acceptance: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("acceptance", ctx),
      parse: parseVerdict,
    },
    commit_acceptance: commitFixNode("acceptance"),
    review_spec: {
      nodeType: "acp",
      session: { isolated: true },
      profile: process.env.NAX_FINISH_SPEC_PROFILE || undefined,
      prompt(ctx) {
        const outs = loadCtxOf(ctx);
        return buildReviewPrompt("spec", { base: outs.base ?? "origin/main", specPath: outs.specPath ?? "" });
      },
      parse: parseVerdict,
    },
    route_spec: {
      nodeType: "compute",
      run: (ctx) => routeReview(ctx, "spec"),
    },
    fix_spec: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("spec", ctx),
      parse: parseVerdict,
    },
    commit_spec: commitFixNode("spec"),
    review_quality: {
      nodeType: "acp",
      session: { isolated: true },
      profile: process.env.NAX_FINISH_QUALITY_PROFILE || undefined,
      prompt(ctx) {
        const outs = loadCtxOf(ctx);
        return buildReviewPrompt("quality", { base: outs.base ?? "origin/main", specPath: outs.specPath ?? "" });
      },
      parse: parseVerdict,
    },
    route_quality: {
      nodeType: "compute",
      run: (ctx) => routeReview(ctx, "quality"),
    },
    fix_quality: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("quality", ctx),
      parse: parseVerdict,
    },
    commit_quality: commitFixNode("quality"),
    fix_gate: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("gate", ctx),
      parse: parseVerdict,
    },
    commit_gate: commitFixNode("gate"),
    quality_gates: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const cmds = await loadQualityCommands(i.workdir);
        const r = await runQualityGates(i.workdir, cmds, { timeoutMs: i.timeouts?.gateMs });
        if (r.passed) return { route: "green", ran: r.ran, failing: r.failing, output: r.output };
        // Nothing configured is not a pass — escalate immediately rather than
        // open a "ready" PR having verified nothing. An LLM fix node cannot
        // invent the repo's build/test commands.
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
      },
    },
    open_pr: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        if (loadCtxOf(ctx).route === "nothing-to-finish") {
          await writeResult(i.workdir, { feature: i.feature, status: "nothing-to-finish" });
          return { route: "done", status: "nothing-to-finish" };
        }
        // Every fix node edited the working tree; without this the PR would be
        // opened from a remote branch missing all of them.
        const sync = await commitAndPush(i.workdir, i.branch, `fix(${i.feature}): nax-finish automated fixes`);
        const r = await openOrPromotePr(
          i.workdir,
          i.branch,
          `nax-finish: ${i.feature}`,
          `Automated finish of \`${i.feature}\`.`,
        );
        await writeResult(i.workdir, { feature: i.feature, status: r.status, url: r.url });
        return { route: "done", committed: sync.committed, ...r };
      },
    },
    escalate: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const outs = ctx.outputs as Record<string, { route?: string; reason?: string } | undefined>;
        const routed = ctx.outputs as Record<string, ReviewVerdict | undefined>;
        const verdict =
          routed.route_spec?.route === "escalate"
            ? routed.route_spec
            : routed.route_quality?.route === "escalate"
              ? routed.route_quality
              : undefined;
        const loopExhausted =
          outs.acceptance?.route === "escalate"
            ? outs.acceptance
            : outs.quality_gates?.route === "escalate"
              ? outs.quality_gates
              : undefined;
        const reason =
          verdict?.escalationReason ?? loopExhausted?.reason ?? "nax-finish could not reach a green, shippable state";

        // Push what was fixed so the escalation describes state a human can see.
        // A push failure must not swallow the escalation itself, so it is
        // reported in the message rather than thrown.
        let syncNote = "";
        try {
          await commitAndPush(i.workdir, i.branch, `wip(${i.feature}): nax-finish partial fixes before escalation`);
        } catch (err) {
          syncNote = `\n\n> Note: nax-finish could not push its partial fixes — ${String(err)}`;
        }

        // Write the result BEFORE attempting delivery. Delivery touches the
        // network and the forge — a rate limit, an expired token, a locked PR
        // or an unrecognised remote used to throw here, killing the node before
        // any result existed. The plugin then had nothing to report and, on the
        // Telegram channel, nothing to notify from: the one path whose job is
        // to say "a human is needed" was the one path with no fallback (#1399).
        const result: FinishResult = {
          feature: i.feature,
          status: "escalated",
          escalationReason: reason,
          findings: verdict?.findings ?? [],
        };
        await writeResult(i.workdir, result);

        const comment = buildEscalationComment(i.feature, reason, verdict?.findings ?? []) + syncNote;
        let url: string | undefined;
        let channel: string | undefined;
        let deliveryError: string | undefined;
        try {
          const posted = await postEscalation(i.workdir, i.branch, comment, {
            preferTelegram: i.escalateTelegram,
          });
          url = posted.url;
          channel = posted.channel;
        } catch (err) {
          deliveryError = String(err);
        }
        await writeResult(i.workdir, { ...result, url, deliveryError });

        return { route: "done", url, channel, deliveryError, escalationReason: reason };
      },
    },
  },
  edges: [
    { from: "load_ctx", switch: { on: "$.route", cases: { proceed: "acceptance", "nothing-to-finish": "open_pr" } } },
    {
      from: "acceptance",
      switch: { on: "$.route", cases: { proceed: "review_spec", fix: "fix_acceptance", escalate: "escalate" } },
    },
    // Each fix commits before anything re-reads the diff: the reviewers see
    // `git diff <base>...HEAD` only, so an uncommitted fix would be re-reported
    // verbatim until the cap escalated it (#1397).
    { from: "fix_acceptance", to: "commit_acceptance" },
    { from: "commit_acceptance", to: "acceptance" },
    { from: "review_spec", to: "route_spec" },
    {
      from: "route_spec",
      switch: { on: "$.route", cases: { clean: "review_quality", fix: "fix_spec", escalate: "escalate" } },
    },
    // Spec fixes re-run the acceptance gate first (they can break it), and the
    // acceptance node's `proceed` edge leads back into review_spec for re-review.
    { from: "fix_spec", to: "commit_spec" },
    { from: "commit_spec", to: "acceptance" },
    { from: "review_quality", to: "route_quality" },
    {
      from: "route_quality",
      switch: { on: "$.route", cases: { clean: "quality_gates", fix: "fix_quality", escalate: "escalate" } },
    },
    // Quality fixes are re-reviewed by the same lens; the repo-root gates that
    // follow catch anything the fix broke mechanically.
    { from: "fix_quality", to: "commit_quality" },
    { from: "commit_quality", to: "review_quality" },
    {
      from: "quality_gates",
      switch: { on: "$.route", cases: { green: "open_pr", fix: "fix_gate", escalate: "escalate" } },
    },
    { from: "fix_gate", to: "commit_gate" },
    { from: "commit_gate", to: "quality_gates" },
  ],
});
