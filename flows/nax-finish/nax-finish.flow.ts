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
 */
import { defineFlow, extractJsonObject } from "acpx/flows";
import { buildReviewPrompt, fixPrompt } from "./review-prompts";
import {
  _contextDeps,
  buildEscalationComment,
  detectBaseBranch,
  loadQualityCommands,
  openOrPromotePr,
  parseAcceptanceGroups,
  postEscalation,
  preflight,
  resolveSpec,
  runAcceptanceGate,
  runQualityGates,
  writeResult,
} from "./steps";
import type { FinishInput, ReviewVerdict } from "./types";

const inputOf = (ctx: { input: unknown }) => ctx.input as FinishInput;

/**
 * Cap on acceptance/quality-gate fix-and-reverify iterations before
 * escalating instead of looping forever. acpx's flow engine has no built-in
 * cycle guard, so without this cap a stubborn failure (LLM can't fix it, or
 * fixes something else each time) hangs `acpx flow run` — and the post-run
 * plugin awaits that subprocess with no timeout, hanging the whole run's
 * completion phase indefinitely.
 */
const MAX_FIX_ATTEMPTS = 3;

function fixAttemptCount(ctx: { state: { steps: { nodeId: string }[] } }, fixNodeId: string): number {
  return ctx.state.steps.filter((s) => s.nodeId === fixNodeId).length;
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
      nodeType: "compute",
      async run(ctx) {
        const i = inputOf(ctx);
        const base = await detectBaseBranch(i.workdir);
        const { specPath } = await resolveSpec(i.feature, i.workdir);
        const pf = await preflight(i.workdir, base);
        return { base, specPath, route: pf.route };
      },
    },
    acceptance: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const res = await _contextDeps.run(["nax", "features", "resolve", i.feature, "--json"], { cwd: i.workdir });
        const { groups } = parseAcceptanceGroups(res.stdout);
        const r = await runAcceptanceGate(i.workdir, groups);
        if (r.passed) return { route: "proceed", output: r.output };
        const attempts = fixAttemptCount(ctx, "fix_acceptance");
        if (attempts >= MAX_FIX_ATTEMPTS) {
          return {
            route: "escalate",
            reason: `Acceptance tests still failing after ${attempts} fix attempts.`,
            output: r.output,
          };
        }
        return { route: "fix", output: r.output };
      },
    },
    fix_acceptance: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("acceptance", ctx),
      parse: (t) => extractJsonObject(t) as ReviewVerdict,
    },
    review_spec: {
      nodeType: "acp",
      session: { isolated: true },
      profile: process.env.NAX_FINISH_SPEC_PROFILE || undefined,
      prompt(ctx) {
        const outs = ctx.outputs as Record<string, { base?: string; specPath?: string }>;
        return buildReviewPrompt("spec", {
          base: outs.load_ctx?.base ?? "origin/main",
          specPath: outs.load_ctx?.specPath ?? "",
        });
      },
      parse: (text) => extractJsonObject(text) as ReviewVerdict,
    },
    review_quality: {
      nodeType: "acp",
      session: { isolated: true },
      profile: process.env.NAX_FINISH_QUALITY_PROFILE || undefined,
      prompt(ctx) {
        const outs = ctx.outputs as Record<string, { base?: string; specPath?: string }>;
        return buildReviewPrompt("quality", {
          base: outs.load_ctx?.base ?? "origin/main",
          specPath: outs.load_ctx?.specPath ?? "",
        });
      },
      parse: (text) => extractJsonObject(text) as ReviewVerdict,
    },
    fix_spec: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("spec", ctx),
      parse: (t) => extractJsonObject(t) as ReviewVerdict,
    },
    fix_quality: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("quality", ctx),
      parse: (t) => extractJsonObject(t) as ReviewVerdict,
    },
    fix_gate: {
      nodeType: "acp",
      prompt: (ctx) => fixPrompt("gate", ctx),
      parse: (t) => extractJsonObject(t) as ReviewVerdict,
    },
    quality_gates: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const cmds = await loadQualityCommands(i.workdir);
        const r = await runQualityGates(i.workdir, cmds);
        if (r.passed) return { route: "green", failing: r.failing, output: r.output };
        const attempts = fixAttemptCount(ctx, "fix_gate");
        if (attempts >= MAX_FIX_ATTEMPTS) {
          return {
            route: "escalate",
            reason: `Quality gates still failing after ${attempts} fix attempts (${r.failing.join(", ")}).`,
            failing: r.failing,
            output: r.output,
          };
        }
        return { route: "fix", failing: r.failing, output: r.output };
      },
    },
    open_pr: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const outs = ctx.outputs as Record<string, { route?: string } | undefined>;
        if (outs.load_ctx?.route === "nothing-to-finish") {
          await writeResult(i.workdir, { feature: i.feature, status: "nothing-to-finish" });
          return { route: "done", status: "nothing-to-finish" };
        }
        const r = await openOrPromotePr(
          i.workdir,
          i.branch,
          `nax-finish: ${i.feature}`,
          `Automated finish of \`${i.feature}\`.`,
        );
        await writeResult(i.workdir, { feature: i.feature, status: r.status, url: r.url });
        return { route: "done", ...r };
      },
    },
    escalate: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
        const reviewOuts = ctx.outputs as Record<string, ReviewVerdict | undefined>;
        const loopOuts = ctx.outputs as Record<string, { route?: string; reason?: string } | undefined>;
        const verdict =
          reviewOuts.review_spec?.route === "escalate"
            ? reviewOuts.review_spec
            : reviewOuts.review_quality?.route === "escalate"
              ? reviewOuts.review_quality
              : undefined;
        const loopExhausted =
          loopOuts.acceptance?.route === "escalate"
            ? loopOuts.acceptance
            : loopOuts.quality_gates?.route === "escalate"
              ? loopOuts.quality_gates
              : undefined;
        const reason =
          verdict?.escalationReason ?? loopExhausted?.reason ?? "nax-finish could not reach a green, shippable state";
        const comment = buildEscalationComment(i.feature, reason, verdict?.findings ?? []);
        const { url } = await postEscalation(i.workdir, i.branch, comment);
        await writeResult(i.workdir, { feature: i.feature, status: "escalated", url, escalationReason: reason });
        return { route: "done", url, escalationReason: reason };
      },
    },
  },
  edges: [
    { from: "load_ctx", switch: { on: "$.route", cases: { proceed: "acceptance", "nothing-to-finish": "open_pr" } } },
    {
      from: "acceptance",
      switch: { on: "$.route", cases: { proceed: "review_spec", fix: "fix_acceptance", escalate: "escalate" } },
    },
    { from: "fix_acceptance", to: "acceptance" },
    { from: "review_spec", switch: { on: "$.route", cases: { proceed: "fix_spec", escalate: "escalate" } } },
    { from: "fix_spec", to: "review_quality" },
    { from: "review_quality", switch: { on: "$.route", cases: { proceed: "fix_quality", escalate: "escalate" } } },
    { from: "fix_quality", to: "quality_gates" },
    {
      from: "quality_gates",
      switch: { on: "$.route", cases: { green: "open_pr", fix: "fix_gate", escalate: "escalate" } },
    },
    { from: "fix_gate", to: "quality_gates" },
  ],
});
