/**
 * Operating-tier resolution — SSOT for "which rung will this story run at?".
 *
 * Two callers must answer this identically:
 * - the routing stage (`src/pipeline/stages/routing.ts`), authoritatively, once
 *   classification has produced a derived tier;
 * - `buildPreviewRouting` (`src/execution/executor-types.ts`), ahead of the
 *   pipeline, to announce the story (story.start log, story:started event,
 *   status display, dry run).
 *
 * When the two diverge, a run announces one tier and executes another — the
 * reporting half of #1575. Keeping the rule here means the preview can only be
 * wrong about the *derived* tier (which needs classification), never about the
 * precedence between profile, escalation, and persisted values.
 */

import type { TierConfig } from "@/config";

/**
 * Rank = the rung's index in tierOrder. Agent-qualified tuple match when the ladder has agent rungs.
 *
 * The tuple-matching rule deliberately mirrors getTierConfig/escalateTier in
 * src/execution/escalation/escalation.ts:43-60: when agent rungs are present,
 * find the exact (tier, agent) rung; otherwise (or when the rung carries no
 * agent) fall back to the first tier-name match.
 */
function rankRung(tierOrder: TierConfig[], tier: string, agent: string | undefined): number | undefined {
  const hasAgentRungs = tierOrder.some((r) => r.agent !== undefined);
  const i =
    hasAgentRungs && agent !== undefined
      ? tierOrder.findIndex((t) => t.tier === tier && t.agent === agent)
      : tierOrder.findIndex((t) => t.tier === tier);
  return i === -1 ? undefined : i;
}

export interface OperatingTierInput {
  /** Tier persisted on the story by a previous iteration or run, if any. */
  previousTier?: string;
  /** Agent persisted alongside previousTier — escalation persists both. */
  previousAgent?: string;
  /** Tier the story's agent profile targets — seeds the starting rung. */
  profileTier?: string;
  /** The profile assignment's agent, paired with profileTier. */
  profileAgent?: string;
  /** Tier derived from this story's complexity classification. */
  derivedTier: string;
  /** Set by rung-qualified complexityRouting (Task 4); callers pass undefined until then. */
  derivedAgent?: string;
  /** Whether the story carries at least one escalation record. */
  hasEscalationRecords: boolean;
  /** Escalation ladder; absent/empty ⇒ nothing is rankable; only records keep previousTier. */
  tierOrder?: TierConfig[];
}

export interface OperatingTierResult {
  /** The rung the story operates on. */
  tier: string;
  /** True when `previousTier` was kept because it represents a real escalation. */
  isEscalated: boolean;
  /** The tier that would have been used had no escalation been in play. */
  candidateTier: string;
  /** `previousTier` was set but unrankable and unbacked by an escalation record. */
  unknownPreviousTier: boolean;
}

/**
 * Resolve the tier a story operates on.
 *
 * - A profile target seeds the STARTING rung and overrides the complexity-derived
 *   tier (agent-profile routing, Open Item B).
 * - A genuine escalation still wins. An escalation record is honoured outright,
 *   because a cross-agent ladder can escalate sideways or down — e.g.
 *   agentA/powerful -> agentB/balanced — and rank comparison alone would discard
 *   that as "not an escalation" (#1522). With no record, a higher-ranked previous
 *   tier is kept so an escalation that predates record-keeping survives, while a
 *   lower-ranked leftover from an unrelated run does not stick.
 */
export function resolveOperatingTier(input: OperatingTierInput): OperatingTierResult {
  const { previousTier, previousAgent, profileTier, profileAgent, derivedTier, derivedAgent, hasEscalationRecords } =
    input;
  const tierOrder = input.tierOrder ?? [];

  const candidateTier = profileTier ?? derivedTier;
  const candidateAgent = profileTier !== undefined ? profileAgent : derivedAgent;
  const candidateRank = rankRung(tierOrder, candidateTier, candidateAgent);
  const previousRank = previousTier !== undefined ? rankRung(tierOrder, previousTier, previousAgent) : undefined;

  const isEscalated =
    previousTier !== undefined &&
    (hasEscalationRecords ||
      (previousRank !== undefined && candidateRank !== undefined && previousRank > candidateRank));

  return {
    tier: isEscalated ? previousTier : candidateTier,
    isEscalated,
    candidateTier,
    unknownPreviousTier: previousTier !== undefined && previousRank === undefined && !hasEscalationRecords,
  };
}
