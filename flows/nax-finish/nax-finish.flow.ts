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
 * - `quality_gates` re-runs the feature's acceptance tests before the repo's
 *   own commands. The quality-review and gate fix loops both edit code after
 *   the `acceptance` node last passed, and the repo-root `test` command does
 *   not cover per-feature acceptance tests — so without this a fix could break
 *   the contract the first gate proved and still ship.
 * - `commit_gate` re-enters `review_quality` when it committed anything, so no
 *   fix reaches the PR unreviewed — the gate loop was previously the one
 *   editing loop whose output only ever faced mechanical checks.
 * - Every `commit_*` node appends its round to the finish-audit trail. That is
 *   the only place a round's findings and its commit are both in scope:
 *   `ctx.outputs` holds one output per node, so the next round overwrites it.
 */
import { defineFlow, extractJsonObject } from "acpx/flows";
import { buildFixCommitMessage } from "./commit-message";
import { findingsOf, fixAttemptCount, gateOutputs, incrementalSince, inputOf, loadCtxOf } from "./flow-ctx";
import { buildReviewPrompt, fixPrompt } from "./review-prompts";
import {
  _contextDeps,
  appendRound,
  buildEscalationComment,
  commitAndPush,
  commitFixes,
  detectBaseBranch,
  filesInCommit,
  loadQualityCommands,
  openOrPromotePr,
  partitionTestFiles,
  postEscalation,
  preflight,
  resolveFeature,
  runAcceptanceGate,
  runQualityGates,
  writeResult,
} from "./steps";
import type { FinishInput, FinishPhase, FinishResult, ReviewVerdict } from "./types";

/**
 * Cap on fix-and-reverify iterations, per phase, before escalating instead of
 * looping forever. acpx's flow engine has no built-in cycle guard, so without
 * this cap a stubborn failure (LLM can't fix it, or fixes something else each
 * time) hangs `acpx flow run` — and the post-run plugin awaits that subprocess.
 */
const MAX_FIX_ATTEMPTS = 3;

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
 *
 * Also the audit seam: this is the only point in the graph where a round's
 * findings and its commit are both known. `ctx.outputs` keeps only the latest
 * output per node, so a round not recorded here is a round no terminal node
 * can reconstruct.
 */
/**
 * Route for `commit_gate`, whose successor depends on what the fix touched.
 *
 * - `unchanged` — nothing committed; no new diff, so nothing to review.
 * - `tests-only` — every touched path matched the repo's test-file patterns.
 *   Skipped by explicit choice: the re-review is the flow's most expensive node
 *   and a gate fix is usually a mechanical test repair. **This is a real hole.**
 *   The defect that motivated the re-entry (rs-stock `b6fb66dd`) was itself
 *   test-only — 8 copy-pasted stubs across 3 test files — so this route would
 *   not have caught it. Widen it here if test-quality regressions start
 *   shipping.
 * - `changed` — production code was touched, or the paths could not be
 *   classified at all. "Cannot classify" reviews rather than skips.
 */
async function gateCommitRoute(
  i: FinishInput,
  committed: boolean,
  shaAfter: string | null,
  testFileRegex: string[],
): Promise<string> {
  if (!committed || !shaAfter) return "unchanged";
  const files = await filesInCommit(i.workdir, shaAfter);
  if (files.length === 0) return "changed";
  return partitionTestFiles(files, testFileRegex).nonTest.length > 0 ? "changed" : "tests-only";
}

/**
 * Build the `commit_<phase>` node that follows `fix_<phase>`.
 *
 * One node per phase rather than a single shared one because each returns to a
 * different successor, and acpx routes on the node id — a shared node would
 * need a switch reconstructing which fix ran from the step history.
 *
 * Also the audit seam: this is the only point in the graph where a round's
 * findings and its commit are both known. `ctx.outputs` keeps only the latest
 * output per node, so a round not recorded here is a round no terminal node
 * can reconstruct. `shaBefore` is recorded for the same reason — it is what the
 * next review of this phase diffs from (see `incrementalSince`).
 */
function commitFixNode(phase: FinishPhase) {
  return {
    nodeType: "action" as const,
    async run(ctx: {
      input: unknown;
      outputs: unknown;
      state: { steps: { nodeId: string }[] };
    }): Promise<{ committed: boolean; route: string; shaBefore: string | null; shaAfter: string | null }> {
      const i = inputOf(ctx);
      const messageCtx = { outputs: ctx.outputs as Record<string, unknown> };
      // skipHooks: an intermediate checkpoint must not be rejected by a repo's
      // pre-commit hook — quality_gates runs the repo's real gates before any
      // PR opens, and a hook failure here would kill the flow mid-loop.
      const { committed, shaBefore, shaAfter } = await commitFixes(
        i.workdir,
        buildFixCommitMessage(phase, i.feature, messageCtx),
        { skipHooks: true },
      );
      await appendRound(i, {
        ts: new Date().toISOString(),
        phase,
        attempt: fixAttemptCount(ctx, `fix_${phase}`),
        committed,
        findings: findingsOf(ctx, phase),
        ...(phase === "gate" ? { failing: gateOutputs(ctx).failing ?? [] } : {}),
      });
      // Only `commit_gate` routes on this; the other phases have unconditional
      // edges and ignore it.
      const route =
        phase === "gate"
          ? await gateCommitRoute(i, committed, shaAfter, loadCtxOf(ctx).testFileRegex ?? [])
          : committed
            ? "changed"
            : "unchanged";
      return { committed, route, shaBefore, shaAfter };
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
          testFileRegex: resolution.testFileRegex,
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
        return buildReviewPrompt("spec", {
          base: outs.base ?? "origin/main",
          specPath: outs.specPath ?? "",
          since: incrementalSince(ctx, "spec"),
          priorFindings: findingsOf(ctx, "spec"),
        });
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
        return buildReviewPrompt("quality", {
          base: outs.base ?? "origin/main",
          specPath: outs.specPath ?? "",
          since: incrementalSince(ctx, "quality"),
          priorFindings: findingsOf(ctx, "quality"),
        });
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

        // Acceptance is gate zero here, not just at the `acceptance` node.
        // Both fix loops that run after it — quality review and this gate —
        // edit code, and the repo-root `test` command does not cover the
        // feature's acceptance tests: they live under `<pkg>/.nax/features/<f>/`
        // and usually need their own runner config. Re-running them here is what
        // makes "nothing reaches open_pr without the feature's own contract
        // passing against the tree as it will ship" true on every path (#1398).
        //
        // Unconditional, though the common green path re-runs a gate that
        // already passed: acceptance is the cheapest gate in the pipeline, and a
        // conditional skip derived from step history would be a check that can
        // be *wrong* — a silent false green, the failure mode this exists to
        // prevent.
        //
        // `missing` is deliberately ignored: groups are resolved once at
        // load_ctx, so a coverage hole was already escalated by the acceptance
        // node and cannot appear here.
        const acc = await runAcceptanceGate(i.workdir, loadCtxOf(ctx).groups ?? [], {
          timeoutMs: i.timeouts?.acceptanceMs,
        });
        if (!acc.passed) {
          // Short-circuit: the repo gates are re-run next round anyway, and
          // skipping them keeps this out of the "nothing configured" branch
          // below, which would otherwise misreport configured-but-skipped
          // commands as absent.
          const accAttempts = fixAttemptCount(ctx, "fix_gate");
          const failing = ["acceptance"];
          if (accAttempts >= MAX_FIX_ATTEMPTS) {
            return {
              route: "escalate",
              reason: `A later fix broke the feature's own contract: acceptance still failing after ${accAttempts} fix attempts.`,
              ran: [],
              failing,
              output: acc.output,
            };
          }
          return { route: "fix", ran: [], failing, output: acc.output };
        }

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
          await writeResult(i, { feature: i.feature, status: "nothing-to-finish" });
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
        await writeResult(i, { feature: i.feature, status: r.status, url: r.url });
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
        await writeResult(i, result);

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
        await writeResult(i, { ...result, url, deliveryError });

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
    // A gate fix that changed code goes back through the quality reviewer, not
    // straight to the gates. The gate loop is the last one to edit the tree and
    // was the only one whose edits nothing reviewed: `quality_gates` proves the
    // repo's commands are green, which a bad fix can satisfy. Observed on
    // rs-stock/pipeline-run-outcome — the gate round repaired 8 tests by
    // copy-pasting an identical 4-line stub into each, and it shipped, because
    // no reviewer ran after it. Re-entry costs one review per gate round; both
    // loops stay bounded by their own MAX_FIX_ATTEMPTS caps.
    //
    // `unchanged` skips it: with nothing committed there is no new diff to
    // review, and re-running the reviewer on an identical tree would burn a
    // turn to re-report what route_quality already called clean.
    {
      from: "commit_gate",
      switch: {
        on: "$.route",
        cases: { changed: "review_quality", "tests-only": "quality_gates", unchanged: "quality_gates" },
      },
    },
  ],
});
