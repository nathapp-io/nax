/**
 * Run Setup — Warnings
 *
 * Pre-flight warnings emitted by setupRun before the run begins. Pulled out of
 * run-setup.ts to keep that file focused on wiring. Two warnings:
 *  - `warnProfileMismatch` — story-level agentProfileId / agent references that
 *    no longer resolve in config.routing.agents.profiles / config.models, plus
 *    the PRD-level check that the resolved profile matches what plan used.
 *  - `warnFallbackMisconfiguration` — AC-35 pre-flight: fallback candidates that
 *    `agentGetFn` cannot resolve.
 *  - `warnInertBashStages` — ADR-030 pre-flight: stages that declare the Bash
 *    tool while their resolved grants hold no `Bash` entry, so the tool is
 *    never offered and nothing can escalate.
 *
 * No behaviour change from the original inline versions — pure code move.
 */

import type { NaxConfig } from "@/config";
import { findInertBashStages, resolvePermissions } from "@/config";
import type { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd";

/**
 * Emit a warning for each story whose agentProfileId no longer exists in
 * config.routing.agents.profiles (Task 10 Part B — profile-mismatch check).
 *
 * This handles the case where a user runs an old PRD after removing a profile
 * from config. The existing routing.agent assignment is retained — warn only,
 * no throw.
 */
export function warnProfileMismatch(prd: PRD, config: NaxConfig, logger: ReturnType<typeof getSafeLogger>): void {
  const profiles = config.routing?.agents?.profiles ?? [];
  const profileIds = new Set(profiles.map((p) => p.id));

  // PRD-level check (Delta C4): warn when the run resolves a different config
  // profile than the one the PRD was planned with — the escalation ladder and
  // agent-profile registry may differ from what plan assumed.
  if (prd.routingProfile !== undefined) {
    const current = config.profile ?? "default";
    if (prd.routingProfile !== current) {
      logger?.warn(
        "prd",
        `PRD was planned with config profile "${prd.routingProfile}" but this run resolved profile "${current}" — the escalation ladder and agent profiles may differ from what plan assumed. Re-run with --profile ${prd.routingProfile} to match.`,
        { storyId: "prd", plannedProfile: prd.routingProfile, currentProfile: current },
      );
    }
  }

  const knownAgents = new Set(Object.keys(config.models ?? {}));

  for (const story of prd.userStories) {
    const profileId = story.routing?.agentProfileId;
    if (profileId && !profileIds.has(profileId)) {
      logger?.warn(
        "setup",
        `Story ${story.id} was planned with profile ${profileId} which no longer exists in config — routing.agent assignment retained`,
        { storyId: story.id, agentProfileId: profileId },
      );
    }
    const storyAgent = story.routing?.agent;
    if (storyAgent && !knownAgents.has(storyAgent)) {
      logger?.warn(
        "setup",
        `Story ${story.id} routes to agent "${storyAgent}" which is not defined in config.models — execution will degrade to the default agent`,
        { storyId: story.id, agent: storyAgent },
      );
    }
  }
}

/**
 * Emit a warning for each fallback candidate in config.agent.fallback.map
 * that cannot be resolved by agentGetFn (AC-35 pre-flight check).
 *
 * Deduplicates warnings so each unconfigured candidate is reported once even
 * if it appears under multiple primary agents.
 */
export function warnFallbackMisconfiguration(
  config: NaxConfig,
  agentGetFn: ((name: string) => unknown) | undefined,
  logger: ReturnType<typeof getSafeLogger>,
): void {
  if (!agentGetFn) return;
  const fallback = config.agent?.fallback;
  if (!fallback?.enabled || !fallback.map) return;

  const warned = new Set<string>();
  for (const [primaryAgent, candidates] of Object.entries(fallback.map)) {
    for (const candidate of candidates) {
      const candidateName = typeof candidate === "string" ? candidate : candidate.agent;
      if (warned.has(candidateName)) continue;
      if (!agentGetFn(candidateName)) {
        logger?.warn("fallback", "Fallback candidate not available — will be skipped if triggered", {
          storyId: "_setup",
          primaryAgent,
          candidate: candidateName,
        });
        warned.add(candidateName);
      }
    }
  }
}

/**
 * Warn once per stage that declares the Bash tool but whose resolved
 * permissions cannot offer it (ADR-030).
 *
 * A warning, never an error: `gated` without a `Bash(...)` rule is a legitimate
 * "no shell" posture. It is only worth saying out loud because the alternative
 * reading — "the agent can ask, and a human approves" — is what the mode name
 * suggests and is not what happens.
 *
 * The message names the stage, the mode, and the rule that would fix it so a
 * reader who only sees the log line can act on it. The data object carries
 * `{ storyId: "_setup", stage, bashApproval }` for downstream tooling.
 *
 * Silence here means escalation is reachable wherever the stage dispatches:
 * every Bash-dispatching call site attaches an ask resolver, which
 * `scripts/check-bash-dispatch-ask.ts` enforces (#2202).
 */
export function warnInertBashStages(config: NaxConfig, logger: ReturnType<typeof getSafeLogger>): void {
  const inertStages = findInertBashStages(config);
  for (const stage of inertStages) {
    const resolved = resolvePermissions(config, stage).bashApproval;
    logger?.warn(
      "permissions",
      `bashApproval "${resolved}" on stage "${stage}" grants no Bash (no Bash(...) allow rule) -- the agent is not offered Bash, so nothing can escalate. Add one rule: "allow": ["Bash(ls *, cat *, git status*)"]`,
      { storyId: "_setup", stage, bashApproval: resolved },
    );
  }
}
