/**
 * ADR-012 migration shim — runs BEFORE NaxConfigSchema.safeParse() in loader.ts.
 *
 * Migrates two legacy keys into config.agent.*:
 *   - autoMode.defaultAgent        → agent.default
 *   - autoMode.fallbackOrder[]     → agent.fallback.map (keyed by primary)
 *
 * Note: context.v2.fallback → agent.fallback migration was removed in ADR-012 Phase 5.
 * The context.v2.fallback schema field was deleted; agent.fallback is the canonical
 * location (controlled by config.agent.fallback).
 *
 * Warn-once per loadConfig() call — dedupe by message (the project logger already
 * has this behaviour; we still only emit one warning per legacy key).
 *
 * Shim lives for 3 canary releases, then removed in Phase 6.
 */

type Logger = { warn: (scope: string, message: string, data?: Record<string, unknown>) => void } | null;

export function applyAgentConfigMigration(conf: Record<string, unknown>, logger: Logger): Record<string, unknown> {
  const migrated = { ...conf };
  const agent = { ...((migrated.agent as Record<string, unknown> | undefined) ?? {}) };

  const autoMode = migrated.autoMode as Record<string, unknown> | undefined;

  // 1. autoMode.defaultAgent → agent.default
  // Always warn when legacy key is present; only migrate if canonical key is absent.
  if (typeof autoMode?.defaultAgent === "string") {
    logger?.warn("config", "autoMode.defaultAgent is deprecated — use agent.default (see ADR-012)", {
      legacy: autoMode.defaultAgent,
    });
    if (agent.default === undefined) {
      agent.default = autoMode.defaultAgent;
    }
  }

  // 2. autoMode.fallbackOrder: [primary, ...rest] → agent.fallback.map: { primary: [...rest] }
  if (Array.isArray(autoMode?.fallbackOrder) && (autoMode.fallbackOrder as unknown[]).length > 1) {
    const list = autoMode.fallbackOrder as string[];
    logger?.warn("config", "autoMode.fallbackOrder is deprecated — use agent.fallback.map (see ADR-012)", {
      legacy: list,
    });
    const [primary, ...rest] = list;
    const fallback = { ...((agent.fallback as Record<string, unknown> | undefined) ?? {}) };
    const map = { ...((fallback.map as Record<string, string[]> | undefined) ?? {}) };
    if (primary && !map[primary]) map[primary] = rest;
    fallback.map = map;
    if (fallback.enabled === undefined) fallback.enabled = true;
    agent.fallback = fallback;
  }

  if (Object.keys(agent).length > 0) {
    migrated.agent = agent;
  }
  return migrated;
}
