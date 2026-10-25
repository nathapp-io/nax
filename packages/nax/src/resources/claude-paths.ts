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
