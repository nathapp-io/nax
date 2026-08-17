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
 * - `commit_gate` re-enters `review_quality` whenever its fix committed — the
 *   gate loop was otherwise the one editing loop whose output faced only
 *   mechanical checks, which a fix that degrades the tests it repairs will
 *   satisfy. A test-only fix used to skip the re-review as a cost tradeoff;
 *   #1510 closed that hole. See `gateCommitRoute`.
 * - `load_ctx` and `open_pr` both route to `escalate` rather than throwing on
 *   their own failures. acpx has no error edge, so a throw ends the run with no
 *   result file for the plugin to read or notify from — the one outcome that
 *   must always be reported is "a human is needed" (#1399). `open_pr` matters
 *   most: it is reached only after every gate is green, so a failed push or
 *   forge call there discards a completed, verified run.
 * - Every `commit_*` node appends its round to the finish-audit trail as it
 *   happens, rather than a terminal node reconstructing them from
 *   `ctx.state.steps`. Appending live is what makes the trail survive a flow
 *   that is killed or times out — no terminal node runs on that path, and a
 *   crashed finish is exactly when the record of what it changed matters most.
 */
import { defineFlow } from "acpx/flows";
import { buildFixCommitMessage } from "./commit-message";
import {
  findingsOf,
  fixAttemptCount,
  gateOutputs,
  incrementalSince,
  inputOf,
  loadCtxOf,
  reviewGapsOf,
} from "./flow-ctx";
import { narrativePrompt, parseNarrativeNode } from "./narrative";
import { buildReviewPrompt, fixPrompt } from "./review-prompts";
import {
  _contextDeps,
  acceptanceGateNode,
  amendPrBodyNode,
  appendRound,
  buildCommitRound,
  buildEscalationComment,
  commitAndPush,
  commitFixes,
  detectBaseBranch,
  detectForge,
  filesInCommit,
  loadFinishPrContext,
  openOrPromotePr,
  partitionTestFiles,
  postEscalation,
  preflight,
  qualityGatesNode,
  resolveFeature,
  routeReviewAndRecord,
  validateDispositions,
  writeResult,
} from "./steps";
import type { Forge } from "./steps/forge";
import { _prBodyDeps, buildFinishBody, buildFinishTitle } from "./steps/pr-body";
import type { FindingDisposition, FinishInput, FinishPhase, FinishResult, ReviewVerdict } from "./types";
import { parseFixVerdict, parseReviewVerdict } from "./verdict";

/**
 * Disabled only on an explicit "0". An unset variable means enabled, so a flow
 * invoked directly by `acpx flow run` — outside the plugin that sets the env —
 * still writes the narrative.
 */
const NARRATIVE_ENABLED = process.env.NAX_FINISH_NARRATIVE !== "0";

/**
 * Injectable seam for the `open_pr` node's title/body assembly — tests stub
 * these to control the fallback-vs-built-metadata paths without a real PRD or
 * git checkout.
 */
export const _openPrDeps = {
  loadFinishPrContext,
  buildFinishTitle,
  buildFinishBody,
};

/**
 * Route for `commit_gate`, whose successor depends on what the fix touched.
 *
 * - `unchanged` — nothing committed; no new diff, so nothing to review.
 * - `tests-only` — every touched path matched the repo's test-file patterns.
 * - `changed` — production code was touched, or the paths could not be
 *   classified at all. "Cannot classify" reviews rather than skips.
 *
 * `tests-only` and `changed` both re-enter `review_quality` (#1510). They used
 * to diverge: `tests-only` skipped the re-review as a cost tradeoff, on the
 * reasoning that a gate fix is usually a mechanical test repair. That was a
 * real hole — the defect that motivated the re-entry was itself test-only, 8
 * copy-pasted stubs across 3 test files, so the skip would not have caught the
 * very thing it was built for. A gate fix can turn a red suite green by
 * degrading the tests it repairs, and `quality_gates` is satisfied by exactly
 * that; nothing else read that diff. The audit settled the cost side: across
 * every finish recorded, exactly one `gate` round has ever fired, so the skip
 * was saving a review that almost never runs.
 *
 * The classification is kept even though both routes now review. It is what a
 * cheaper test-quality-scoped reviewer would key off if gate rounds ever become
 * frequent enough for the full re-review to hurt.
 */
async function gateCommitRoute(
  i: FinishInput,
  committed: boolean,
  shaAfter: string | null,
  testFileRegex: string[],
): Promise<string> {
  if (!committed) return "unchanged";
  // Committed, but HEAD did not resolve: the fix is real and unclassifiable, so
  // it must be reviewed. Folding this into the `!committed` branch would skip
  // the review for a change that actually landed — the one direction this
  // function must never fail in.
  if (!shaAfter) return "changed";
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
      // A rejection is only as good as its citation, so the path is checked the
      // same way a reviewer's touchpoints are. A missing file does not veto the
      // rejection — the fixer may have cited a line rather than a path, or moved
      // the file — it marks it, so the PR body (and the commit message below)
      // can say the waiver is unverified rather than silently presenting it as
      // evidenced. Resolved before the commit so the shipped commit message can
      // render a rejection the same way the PR body does, instead of `Fix: …`.
      const dispositions = await validateDispositions(
        i.workdir,
        (ctx.outputs as Record<string, { dispositions?: FindingDisposition[] } | undefined>)[`fix_${phase}`]
          ?.dispositions ?? [],
      );
      // skipHooks: an intermediate checkpoint must not be rejected by a repo's
      // pre-commit hook — quality_gates runs the repo's real gates before any
      // PR opens, and a hook failure here would kill the flow mid-loop.
      const { committed, shaBefore, shaAfter } = await commitFixes(
        i.workdir,
        buildFixCommitMessage(phase, i.feature, messageCtx, { workdir: i.workdir, dispositions }),
        { skipHooks: true },
      );
      // Routed BEFORE the round is recorded: `buildCommitRound` needs the
      // successor to tell an owed-but-skipped re-review from a phase that never
      // had a reviewer. Only `commit_gate` routes on this; the other phases have
      // unconditional edges and ignore it.
      const route =
        phase === "gate"
          ? await gateCommitRoute(i, committed, shaAfter, loadCtxOf(ctx).testFileRegex ?? [])
          : committed
            ? "changed"
            : "unchanged";
      await appendRound(
        i,
        buildCommitRound({
          phase,
          attempt: fixAttemptCount(ctx, `fix_${phase}`),
          committed,
          route,
          findings: findingsOf(ctx, phase),
          failing: phase === "gate" ? (gateOutputs(ctx).failing ?? []) : undefined,
          shaAfter,
          now: new Date().toISOString(),
          dispositions,
        }),
      );
      return { committed, route, shaBefore, shaAfter };
    },
  };
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
          ...(pf.reason ? { reason: pf.reason } : {}),
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
      parse: parseFixVerdict,
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
          gaps: reviewGapsOf(ctx, "spec"),
        });
      },
      parse: parseReviewVerdict,
    },
    route_spec: {
      nodeType: "compute",
      run: (ctx) => routeReviewAndRecord(ctx, "spec"),
    },
    fix_spec: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("spec", ctx),
      parse: parseFixVerdict,
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
          gaps: reviewGapsOf(ctx, "quality"),
        });
      },
      parse: parseReviewVerdict,
    },
    route_quality: {
      nodeType: "compute",
      run: (ctx) => routeReviewAndRecord(ctx, "quality"),
    },
    fix_quality: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("quality", ctx),
      parse: parseFixVerdict,
    },
    commit_quality: commitFixNode("quality"),
    fix_gate: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("gate", ctx),
      parse: parseFixVerdict,
    },
    commit_gate: commitFixNode("gate"),
    quality_gates: {
      nodeType: "action",
      run: qualityGatesNode,
    },
    open_pr: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const loadCtx = loadCtxOf(ctx);
        if (loadCtx.route === "nothing-to-finish") {
          await writeResult(i, { feature: i.feature, status: "nothing-to-finish" });
          return { route: "done", status: "nothing-to-finish" };
        }
        // Every fix node edited the working tree; without this the PR would be
        // opened from a remote branch missing all of them.
        //
        // Routed, not thrown. acpx has no error edge, so a throw here kills the
        // flow — and this is the last node on the happy path, reached only once
        // every gate is green and every fix has landed. It died before
        // `writeResult`, so the plugin found no result file and notified
        // nobody: the #1399 failure mode the `escalate` node was hardened
        // against and this one was not. A protected branch, an expired token or
        // a non-fast-forward push is exactly the kind of dead end `escalate`
        // exists to report.
        let sync: { committed: boolean };
        try {
          sync = await commitAndPush(i.workdir, i.branch, `fix(${i.feature}): nax-finish automated fixes`);
        } catch (error) {
          return {
            route: "escalate",
            reason: `nax-finish could not push "${i.branch}", so no PR was opened: ${String(error)}`,
          };
        }

        const fallbackTitle = `nax-finish: ${i.feature}`;
        const fallbackBody = `Automated finish of \`${i.feature}\`.`;
        let title = fallbackTitle;
        let body = fallbackBody;
        // Detected once, here, and handed to both the body builder (which needs
        // it for the repo template) and the opener. Detecting in both would let
        // them disagree. On a throw it stays undefined and `openOrPromotePr`
        // detects for itself, exactly as it did before.
        let forge: Forge | undefined;
        try {
          forge = await detectForge(_prBodyDeps.run, i.workdir, "finish-pr");
          const prCtx = await _openPrDeps.loadFinishPrContext(i, {
            base: loadCtx.base ?? "",
            gatesRan: gateOutputs(ctx).ran ?? [],
            forge,
            specPath: loadCtx.specPath,
          });
          title = _openPrDeps.buildFinishTitle(prCtx);
          body = _openPrDeps.buildFinishBody(prCtx);
        } catch (error) {
          _prBodyDeps.warn("[finish-pr] Falling back to default PR title/body", { path: i.prdPath, error });
          title = fallbackTitle;
          body = fallbackBody;
        }

        // Same reasoning as the push above: a forge that refuses to create or
        // promote (rate limit, revoked token, unrecognised remote) must reach a
        // human through `escalate`, not take the flow down silently.
        let r: { status: "opened" | "promoted" | "already-ready"; url?: string };
        try {
          r = await openOrPromotePr(i.workdir, i.branch, title, body, forge);
        } catch (error) {
          return {
            route: "escalate",
            reason: `nax-finish could not open or promote the PR for "${i.branch}": ${String(error)}`,
          };
        }
        await writeResult(i, { feature: i.feature, status: r.status, url: r.url });
        // The PR now exists with the mechanical narrative already in place.
        // Anything the narrative node does from here is an improvement on a
        // body that is already correct.
        return { route: NARRATIVE_ENABLED ? "narrate" : "done", committed: sync.committed, ...r };
      },
    },
    narrative: {
      nodeType: "acp",
      session: { isolated: true },
      profile: process.env.NAX_FINISH_NARRATIVE_PROFILE || undefined,
      prompt: narrativePrompt,
      parse: parseNarrativeNode,
    },
    amend_body: {
      nodeType: "action",
      run: amendPrBodyNode,
    },
    // Inert terminal. acpx switch cases must name a real node, so the `done`
    // route out of open_pr needs somewhere to land.
    finish_done: {
      nodeType: "compute",
      run: () => ({ route: "done" }),
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
        // Ordered by how far down the graph the node sits, so the *last* thing
        // that gave up names the reason. `load_ctx` and `open_pr` are here
        // because both can now route here rather than throw — a base ref that
        // does not resolve, and a push or forge call that failed after every
        // gate was green.
        const loopExhausted = [outs.open_pr, outs.quality_gates, outs.acceptance, outs.load_ctx].find(
          (o) => o?.route === "escalate",
        );
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
    {
      from: "load_ctx",
      switch: {
        on: "$.route",
        // `escalate`: the branch could not be measured against its base at all,
        // so neither "proceed" nor "nothing-to-finish" would be a true claim.
        cases: { proceed: "acceptance", "nothing-to-finish": "open_pr", escalate: "escalate" },
      },
    },
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
      switch: {
        on: "$.route",
        cases: {
          clean: "review_quality",
          fix: "fix_spec",
          escalate: "escalate",
          reprompt: "review_spec",
          incomplete: "review_spec",
        },
      },
    },
    // Spec fixes re-run the acceptance gate first (they can break it), and the
    // acceptance node's `proceed` edge leads back into review_spec for re-review.
    { from: "fix_spec", to: "commit_spec" },
    { from: "commit_spec", to: "acceptance" },
    { from: "review_quality", to: "route_quality" },
    {
      from: "route_quality",
      switch: {
        on: "$.route",
        cases: {
          clean: "quality_gates",
          fix: "fix_quality",
          escalate: "escalate",
          reprompt: "review_quality",
          incomplete: "review_quality",
        },
      },
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
        cases: { changed: "review_quality", "tests-only": "review_quality", unchanged: "quality_gates" },
      },
    },
    // The narrative runs only once the PR exists. acpx has no error edge, so an
    // acp node before `open_pr` would be able to fail the flow and cost the PR.
    {
      from: "open_pr",
      switch: { on: "$.route", cases: { narrate: "narrative", done: "finish_done", escalate: "escalate" } },
    },
    { from: "narrative", to: "amend_body" },
  ],
});
