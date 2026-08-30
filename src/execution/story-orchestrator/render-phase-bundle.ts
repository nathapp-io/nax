/**
 * nax#1773 — render the per-stage `ContextBundle` into the op's dispatch
 * input at dispatch time, instead of the value `assemblePlanInputsFromCtx`
 * baked once (before any per-stage bundle existed) at
 * `src/pipeline/stages/execution.ts:166`.
 *
 * `runPhase` (run-phase.ts) already assembles `phaseBundle` for the op's own
 * context-engine stage and puts it on `dispatchCtx.contextBundle` — but the
 * ops never read `ctx.contextBundle`. `write-test.ts` / `implement.ts` /
 * `verify.ts` render `input.promptMarkdown` (a string TddPromptBuilder baked
 * once, with whatever bundle `ctx.contextBundle` held at plan-input time);
 * `semantic-review.ts` / `adversarial-review.ts` render `input.featureCtxBlock`
 * (baked the same way). This module recomputes both from `phaseBundle` so
 * each role renders its OWN stage bundle.
 *
 * Never throws — `runPhase` must dispatch even when a render fails; the
 * caller keeps the plan-time input unchanged on any error.
 */

import type { ContextBundle } from "@/context/engine";
import { getSafeLogger } from "@/logger";
import type { CallContext } from "@/operations";
import { TddPromptBuilder } from "@/prompts";
import { errorMessage } from "@/utils/errors";

export const _renderPhaseBundleDeps = {
  buildForRole: TddPromptBuilder.buildForRole,
};

/** Op names whose `promptMarkdown` was baked by `TddPromptBuilder.buildForRole`. */
const TDD_PROMPT_ROLES = new Set(["test-writer", "implementer", "verifier"]);

/** Op names whose `featureCtxBlock` was baked by `buildFeatureCtxBlock` in plan-inputs.ts. */
const REVIEW_FEATURE_CTX_ROLES: Readonly<Record<string, true>> = {
  "semantic-review": true,
  "adversarial-review": true,
};

interface TddPromptInputShape {
  readonly story?: unknown;
  readonly promptMarkdown?: string;
  readonly contextMarkdown?: string;
  readonly constitution?: string;
  readonly lite?: boolean;
}

/**
 * Re-render `input.promptMarkdown` / `input.featureCtxBlock` from `phaseBundle`
 * when the op is one this fix targets. Every other op passes through unchanged.
 */
export async function applyPhaseBundleToInput(
  opName: string,
  input: unknown,
  phaseBundle: ContextBundle,
  ctx: CallContext,
): Promise<unknown> {
  try {
    if (TDD_PROMPT_ROLES.has(opName)) {
      return await renderTddPromptMarkdown(opName, input, phaseBundle, ctx);
    }
    if (REVIEW_FEATURE_CTX_ROLES[opName]) {
      return renderReviewFeatureCtxBlock(input, phaseBundle);
    }
    return input;
  } catch (err) {
    getSafeLogger()?.warn("execution", "phase-bundle prompt render failed — dispatching with plan-time content", {
      storyId: ctx.storyId,
      stage: opName,
      error: errorMessage(err),
    });
    return input;
  }
}

/**
 * Rebuild the exact prompt `assemblePlanInputsFromCtx` baked (same builder,
 * same section order), swapping only the feature-context bundle for
 * `phaseBundle`. Nothing to rebuild against when the plan never baked a
 * promptMarkdown (legacy/ad-hoc callers) or when `ctx.story` is absent —
 * `TddPromptBuilder.buildForRole` requires it.
 */
async function renderTddPromptMarkdown(
  opName: string,
  input: unknown,
  phaseBundle: ContextBundle,
  ctx: CallContext,
): Promise<unknown> {
  const i = input as TddPromptInputShape;
  if (!i.promptMarkdown?.trim() || !ctx.story) return input;
  // An empty pushMarkdown must NOT be rendered: buildForRole gates its v1
  // fallback on `contextBundle` being present, not on it carrying content
  // (`.featureContext(opts.contextBundle ? undefined : ...)`), so rebuilding
  // against an empty bundle drops feature context the plan-time prompt had.
  // Reachable whenever every provider comes back empty — a repo with no
  // .nax/rules, or a stage whose `stages:` frontmatter filters them all out.
  // Mirrors the same guard on the review path below.
  if (!phaseBundle.pushMarkdown?.trim()) return input;

  const isLite = i.lite ?? ctx.phaseTelemetry?.testStrategy === "three-session-tdd-lite";
  const promptMarkdown = await _renderPhaseBundleDeps.buildForRole(
    opName as "test-writer" | "implementer" | "verifier",
    ctx.packageDir,
    ctx.packageView.config,
    ctx.story,
    {
      lite: isLite,
      contextMarkdown: i.contextMarkdown,
      contextBundle: phaseBundle,
      constitution: i.constitution,
    },
  );

  return { ...(input as Record<string, unknown>), promptMarkdown };
}

/**
 * Mirrors `buildFeatureCtxBlock`'s bundle branch in plan-inputs.ts: the v2
 * bundle's pushMarkdown is already role-filtered by the orchestrator, so it
 * is injected verbatim (no `filterContextByRole` pass).
 */
function renderReviewFeatureCtxBlock(input: unknown, phaseBundle: ContextBundle): unknown {
  const bundleMarkdown = phaseBundle.pushMarkdown?.trim();
  if (!bundleMarkdown) return input;
  return { ...(input as Record<string, unknown>), featureCtxBlock: `${bundleMarkdown}\n\n---\n\n` };
}
