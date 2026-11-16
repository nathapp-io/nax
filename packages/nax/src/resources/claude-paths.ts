import { homedir } from "node:os";
import { join } from "node:path";

export const _claudePathsDeps = { homedir };

/** Claude Code's user-scoped config root, independent of nax's config root. */
export function claudeConfigDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(_claudePathsDeps.homedir(), ".claude");
}

/** Claude Code's own location for .claude.json: inside CLAUDE_CONFIG_DIR when set, else the home directory. */
export function claudeJsonPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.CLAUDE_CONFIG_DIR ?? _claudePathsDeps.homedir(), ".claude.json");
}

/**
 * The user-level skills directory other coding agents read: `<home>/.agents/skills`.
 *
 * Skills installed there (13 on the machine that reported #2959) reach no Claude Code
 * location, so the catalog scans this directory itself. It has no env-var override.
 */
export function agentsSkillsDir(): string {
  return join(_claudePathsDeps.homedir(), ".agents", "skills");
}

/**
 * nax's own user-scoped agents directory, `~/.nax/agents` by default.
 *
 * It takes the same override and default as `globalConfigDir()` and reads them from the
 * caller's `env` rather than `process.env`, so a run's injected environment decides.
 */
export function naxAgentsDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(env.NAX_GLOBAL_CONFIG_DIR ?? join(_claudePathsDeps.homedir(), ".nax"), "agents");
}
