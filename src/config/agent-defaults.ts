/**
 * The built-in agent defaults: protocol, default agent, and each agent's
 * built-in tier map.
 *
 * A dependency-free leaf so the schema, the `agent.protocol` gate and the
 * runtime fallbacks all read one definition (BUG-20: derived, never
 * hand-written at a second site). The gate imports it relatively, so it must
 * stay free of `@/` imports.
 */

export type AgentProtocol = "acp" | "native" | "hybrid";

/** The native agent runs by default, with the acpx agents still reachable. */
export const DEFAULT_AGENT_PROTOCOL: AgentProtocol = "hybrid";

export const DEFAULT_AGENT_NAME = "native";

/** The agent name that routes to the in-process native adapter. */
export const NATIVE_AGENT_NAME = "native";

/**
 * Built-in tier maps. The loader deep-merges every user config over these, so
 * each is present in every loaded config; an untouched map is a default, not a
 * user declaration (see `isBuiltInModelMap`).
 *
 * Native ids must be provider-qualified (nax#1851) and must exist in the
 * bundled pi-ai catalog, or the first dispatch fails with "Unknown model".
 */
export const DEFAULT_MODEL_MAPS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
  native: {
    fast: "anthropic/claude-haiku-4-5",
    balanced: "anthropic/claude-sonnet-5",
    powerful: "anthropic/claude-opus-5-5",
  },
};

/** True when `entry` is exactly the built-in tier map for `agent`. */
export function isBuiltInModelMap(agent: string, entry: unknown): boolean {
  // Own keys only: `models.constructor` must not match Object.prototype.constructor.
  if (!Object.hasOwn(DEFAULT_MODEL_MAPS, agent) || typeof entry !== "object" || entry === null) return false;
  const builtIn = DEFAULT_MODEL_MAPS[agent];
  const tiers = Object.entries(entry as Record<string, unknown>);
  return (
    tiers.length === Object.keys(builtIn).length &&
    tiers.every(([tier, value]) => Object.hasOwn(builtIn, tier) && builtIn[tier] === value)
  );
}
