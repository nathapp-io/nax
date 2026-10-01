/**
 * Unreferenced agent models — declared acpx model maps nothing dispatches to.
 *
 * Under `agent.protocol: "hybrid"` both transports can run in one run, but
 * `agent.protocol` does not route: work nobody assigned runs on
 * `agent.default`, which is `native` by default. An acpx agent runs only where
 * config or the PRD points at it — the default, an enabled fallback rung, any
 * `{agent, model}` / `{agent, tier}` pin (review, finish, acceptance, plan, TDD
 * session tiers, escalation rungs, complexity routes, routing profiles), or a
 * story's `routing.agent`.
 *
 * A user-declared `models.<acpx agent>` map that none of those reaches is dead
 * config: before `native` became the default it was the map every run used, so
 * the user almost certainly means it to run. The built-in `models.claude` map
 * is present in every loaded config and is never reported.
 *
 * Pins are found by SHAPE rather than from a list of config keys: any object
 * carrying a string `agent` beside a `model` or `tier`. A key list goes stale
 * as sites are added (it had already missed finish and acceptance-fix), and a
 * stale list here produces exactly the false warning this must not give.
 * `models` (ModelDef objects carry no `agent`) and `agent` (the fallback map is
 * read separately, gated on `enabled`) are skipped.
 *
 * Root config only, like the other setup-time warnings: a per-package override
 * that reaches the agent is not seen.
 */

import { DEFAULT_AGENT_NAME, isBuiltInModelMap, NATIVE_AGENT_NAME } from "./agent-defaults";
import type { NaxConfig } from "./runtime-types";

const SKIPPED_ROOT_KEYS = new Set(["models", "agent"]);

function isPin(value: Record<string, unknown>): boolean {
  return typeof value.agent === "string" && ("model" in value || "tier" in value);
}

/** Every `agent` named by a pin-shaped object under `value`. */
function pinAgents(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) pinAgents(item, found);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (isPin(record)) found.add(record.agent as string);
  for (const child of Object.values(record)) pinAgents(child, found);
}

function fallbackAgents(config: NaxConfig): string[] {
  const fallback = config.agent?.fallback;
  if (fallback?.enabled !== true) return [];
  return Object.values(fallback.map ?? {}).flatMap((rungs) =>
    (rungs ?? []).map((rung) => (typeof rung === "string" ? rung : rung.agent)),
  );
}

/**
 * The declared acpx agents whose model map nothing reaches.
 *
 * @param storyAgents - `routing.agent` of the PRD's stories, which route per story.
 */
export function findUnreferencedAgentModels(config: NaxConfig, storyAgents: Iterable<string> = []): string[] {
  const reached = new Set<string>([
    config.agent?.default ?? DEFAULT_AGENT_NAME,
    ...fallbackAgents(config),
    ...storyAgents,
  ]);
  for (const [key, value] of Object.entries(config)) {
    if (!SKIPPED_ROOT_KEYS.has(key)) pinAgents(value, reached);
  }
  return Object.entries(config.models ?? {})
    .filter(([agent, map]) => agent !== NATIVE_AGENT_NAME && !isBuiltInModelMap(agent, map) && !reached.has(agent))
    .map(([agent]) => agent);
}

/** One actionable sentence; the fix it names depends on what the protocol permits. */
export function describeUnreferencedAgentModels(agents: readonly string[], config: NaxConfig): string {
  const maps = agents.map((agent) => `models.${agent}`).join(", ");
  const head =
    `${maps} is declared but nothing dispatches to it: no agent.default, enabled fallback rung, pin, escalation rung, ` +
    `complexity route, routing profile or PRD story names ${agents.join(", ")}.`;
  if (config.agent?.protocol === "native") {
    return `${head} Under agent.protocol "native" acpx agents cannot run; remove the map or use protocol "hybrid".`;
  }
  const defaultAgent = config.agent?.default ?? DEFAULT_AGENT_NAME;
  return (
    `${head} Unassigned work runs on agent.default "${defaultAgent}". ` +
    `Set agent.default "${agents[0]}" to run it, or reference it from a pin or fallback rung.`
  );
}
