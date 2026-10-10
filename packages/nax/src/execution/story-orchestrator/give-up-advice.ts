/**
 * A1 caller 2 (spec §4.8, §12): when a story's fix cycle gives up (`UNRESOLVED:`)
 * and no other strategy claims the findings, the advisor rules — retry with its
 * guidance, hand the work across the TDD boundary, waive (out of scope), supersede
 * an AC, or keep today's exit with the ruling attached for the next tier.
 *
 * The ruling reaches the retried dispatch through the ledger and
 * `AdvisorDecisionsProvider` on the `rectify` context stage (spec §12.2).
 * Off for NBF best-effort passes: their give-ups never block a story.
 */
import { join, relative } from "node:path";
import type { AdviceDecision, Advisor, AdvisorCallContext, MenuFacts } from "@/advisor";
import { buildMenu, countStoryRulings, createAdvisor, readDecisions } from "@/advisor";
import { featureDir, isAdvisorCallerEnabled, resolveAdvisorConfig } from "@/config";
import type { Finding, FixStrategy, GiveUpInput, GiveUpResolution } from "@/findings";
import type { CallContext } from "@/operations";

export const _giveUpAdviceDeps = {
  createAdvisor: (actx: AdvisorCallContext): Advisor => createAdvisor(actx),
  readDecisions,
};

type AnyStrategy = FixStrategy<Finding, unknown, unknown, unknown>;
type Hook = (input: GiveUpInput<Finding>) => Promise<GiveUpResolution<Finding> | null>;

const MECHANICAL_SOURCES = new Set(["lint", "typecheck"]);
const AC_PATTERN = /\bAC-?(\d+)\b/i;

export interface GiveUpHookArgs {
  ctx: CallContext;
  strategies: readonly AnyStrategy[];
  isThreeSession: boolean;
  nbfPath: boolean;
}

function flip(f: Finding, to: "test" | "source"): Finding {
  return { ...f, fixTarget: to };
}

/** The first strategy (not one that just gave up) that would claim the findings on the other side, with attempts left. */
function claimantFor(args: GiveUpHookArgs, input: GiveUpInput<Finding>, to: "test" | "source"): string | undefined {
  const gaveUp = new Set(input.gaveUp.map((g) => g.strategyName));
  const flipped = input.findings.map((f) => flip(f, to));
  return args.strategies.find(
    (s) => !gaveUp.has(s.name) && (input.attemptsLeft[s.name] ?? 0) > 0 && flipped.some((f) => s.appliesTo(f)),
  )?.name;
}

function gaveUpTarget(input: GiveUpInput<Finding>): "test" | "source" {
  return input.gaveUp.every((g) => g.strategyName.includes("test-writer")) ? "test" : "source";
}

async function menuFacts(
  args: GiveUpHookArgs,
  input: GiveUpInput<Finding>,
  repoRoot: string,
  feature: string,
  storyId: string,
): Promise<MenuFacts> {
  const config = args.ctx.config ?? args.ctx.runtime.configLoader.current();
  const target = gaveUpTarget(input);
  const to = target === "source" ? "test" : "source";
  const rulings = countStoryRulings(await _giveUpAdviceDeps.readDecisions(repoRoot, feature), storyId);
  const detail = input.gaveUp.map((g) => g.unresolvedDetail).join(" ");
  const ac = AC_PATTERN.exec(detail)?.[1];
  return {
    kind: "fix-cycle-give-up",
    isThreeSession: args.isThreeSession,
    gaveUpTarget: target,
    retryAvailable:
      input.totalAttemptsLeft > 0 && input.gaveUp.some((g) => (input.attemptsLeft[g.strategyName] ?? 0) > 0),
    retargetAvailable: input.totalAttemptsLeft > 0 && claimantFor(args, input, to) !== undefined,
    budgetLeft: rulings < resolveAdvisorConfig(config).maxRulingsPerStory,
    ...(ac ? { citesAc: { storyId, acId: `AC-${ac}` } } : {}),
    acceptanceEnabledForStory: config.acceptance?.enabled !== false,
  };
}

function resolution(
  d: AdviceDecision,
  args: GiveUpHookArgs,
  input: GiveUpInput<Finding>,
): GiveUpResolution<Finding> | null {
  const gaveUpNames = input.gaveUp.map((g) => g.strategyName);
  switch (d.action.type) {
    case "retry":
    case "supersede":
      return { findings: [...input.findings], reinstate: gaveUpNames };
    case "retarget": {
      const to = d.action.to;
      const claimant = claimantFor(args, input, to);
      return claimant ? { findings: input.findings.map((f) => flip(f, to)), reinstate: [claimant] } : null;
    }
    case "waive":
      return { findings: [], reinstate: [] };
    case "escalate-tier":
    case "defer":
      return {
        findings: [...input.findings],
        reinstate: [],
        exit: { detailSuffix: `[advisor ${d.id}: ${d.rationale}]` },
      };
    default:
      return null;
  }
}

/** The fix-cycle `onGiveUp` hook, or undefined when caller 2 is off, this is an NBF pass, or the story is unknown. */
export function buildGiveUpHook(args: GiveUpHookArgs): Hook | undefined {
  const { ctx } = args;
  const config = ctx.config ?? ctx.runtime.configLoader.current();
  if (args.nbfPath || !isAdvisorCallerEnabled(config, "fixCycleGiveUp")) return undefined;
  const storyId = ctx.storyId;
  const feature = ctx.featureName;
  if (!storyId || !feature) return undefined;
  const repoRoot = ctx.runtime.workdir;
  const advisor = _giveUpAdviceDeps.createAdvisor({
    callCtx: ctx,
    repoRoot,
    outputDir: ctx.runtime.outputDir,
    feature,
    runId: ctx.runtime.runId,
    specPath: relative(repoRoot, join(featureDir(repoRoot, feature), "spec.md")),
    workdir: ctx.packageDir,
    queueHeadsUp: (s, text) => ctx.runtime.advisorHeadsUps.push(s, text),
  });
  return async (input) => {
    if (input.findings.every((f) => MECHANICAL_SOURCES.has(f.source))) return null;
    const facts = await menuFacts(args, input, repoRoot, feature, storyId);
    const { decision } = await advisor.advise(
      {
        kind: "fix-cycle-give-up",
        feature,
        storyId,
        summary: input.gaveUp[0]?.unresolvedDetail ?? "The fix agent gave up.",
        evidence: [
          ...input.findings.map((f) => ({
            source: "finding" as const,
            ref: f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : undefined,
            text: `[${f.severity}] ${f.message}`,
          })),
          ...input.gaveUp.map((g) => ({
            source: "agent-diagnosis" as const,
            ref: g.strategyName,
            text: g.unresolvedDetail,
          })),
        ],
        options: buildMenu(facts),
      },
      { findingSeverity: input.findings[0]?.severity },
    );
    return decision ? resolution(decision, args, input) : null;
  };
}

/** Call-site adapter for `runRectification` (complexity-baselined): resolves the strategy list and mode there. */
export function giveUpHookFor(
  ctx: CallContext,
  overrides: { strategies?: readonly AnyStrategy[]; isThreeSession?: boolean } | undefined,
  defaults: readonly AnyStrategy[],
  nbfPath: boolean,
): Hook | undefined {
  return buildGiveUpHook({
    ctx,
    strategies: overrides?.strategies ?? defaults,
    isThreeSession: overrides?.isThreeSession === true,
    nbfPath,
  });
}
