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
        return { route: r.passed ? "proceed" : "fix", output: r.output };
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
        return { route: r.passed ? "green" : "fix", failing: r.failing, output: r.output };
      },
    },
    open_pr: {
      nodeType: "action",
      async run(ctx) {
        const i = inputOf(ctx);
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
        const outs = ctx.outputs as Record<string, ReviewVerdict | undefined>;
        const verdict = outs.review_spec?.route === "escalate" ? outs.review_spec : outs.review_quality;
        const reason = verdict?.escalationReason ?? "nax-finish could not reach a green, shippable state";
        const comment = buildEscalationComment(i.feature, reason, verdict?.findings ?? []);
        const { url } = await postEscalation(i.workdir, i.branch, comment);
        await writeResult(i.workdir, { feature: i.feature, status: "escalated", url, escalationReason: reason });
        return { route: "done", url, escalationReason: reason };
      },
    },
  },
  edges: [
    { from: "load_ctx", switch: { on: "$.route", cases: { proceed: "acceptance", "nothing-to-finish": "open_pr" } } },
    { from: "acceptance", switch: { on: "$.route", cases: { proceed: "review_spec", fix: "fix_acceptance" } } },
    { from: "fix_acceptance", to: "acceptance" },
    { from: "review_spec", switch: { on: "$.route", cases: { proceed: "fix_spec", escalate: "escalate" } } },
    { from: "fix_spec", to: "review_quality" },
    { from: "review_quality", switch: { on: "$.route", cases: { proceed: "fix_quality", escalate: "escalate" } } },
    { from: "fix_quality", to: "quality_gates" },
    { from: "quality_gates", switch: { on: "$.route", cases: { green: "open_pr", fix: "fix_gate" } } },
    { from: "fix_gate", to: "quality_gates" },
  ],
});
