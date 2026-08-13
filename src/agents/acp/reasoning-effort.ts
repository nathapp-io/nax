/**
 * Reasoning-effort application for ACP sessions.
 *
 * acpx 0.13+ selects models through the config-option channel, where the model
 * id is bare and effort is a sibling option. --model is re-sent on every
 * prompt, but effort has no per-prompt carrier, so it is set once when a session
 * is acquired. The option's name is agent-specific — acpx advertises it on the
 * session record as a config option with category "thought_level" (confirmed via
 * `acpx --format json <agent> sessions show <name>`: codex -> "reasoning_effort",
 * claude/opencode -> "effort", pi -> "thought_level"). We ask acpx for the real
 * name first; EFFORT_OPTION_BY_AGENT only backstops discovery failure (older
 * acpx without `sessions show` config_options, a transient spawn error, or a
 * session that hasn't negotiated capabilities yet).
 *
 * Lives outside spawn-client.ts deliberately: that file is at its file-size
 * ratchet ceiling, and a free function with an injected spawn is unit-testable
 * without constructing a client.
 */

import { getSafeLogger } from "@/logger";

/** category acpx uses on the config option that controls reasoning effort. */
const THOUGHT_LEVEL_CATEGORY = "thought_level";

/**
 * Fallback acpx config-option name for reasoning effort, keyed by agent. Used
 * only when live discovery via `sessions show` fails. Agents not listed here
 * don't expose a known effort option and are skipped.
 */
export const EFFORT_OPTION_BY_AGENT: Record<string, string> = {
  codex: "reasoning_effort",
  claude: "effort",
  opencode: "effort",
  pi: "thought_level",
};

type Spawn = (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Ask acpx which config option this agent's session uses for reasoning effort,
 * by matching category "thought_level" in `sessions show`'s config_options.
 * Returns undefined on any discovery failure (spawn failure, malformed JSON,
 * missing/malformed acpx.config_options, or no thought_level entry) so the
 * caller can fall back to the static map.
 */
async function discoverEffortOptionId(params: {
  agentName: string;
  sessionName: string;
  cwd: string;
  storyId?: string;
  spawn: Spawn;
}): Promise<string | undefined> {
  const { agentName, sessionName, cwd, storyId, spawn } = params;
  const cmd = ["acpx", "--cwd", cwd, "--format", "json", agentName, "sessions", "show", sessionName];

  try {
    const { exitCode, stdout, stderr } = await spawn(cmd);
    if (exitCode !== 0) {
      getSafeLogger()?.debug("acp-adapter", "Could not list session config options; falling back to static map", {
        storyId,
        agentName,
        cause: stdout || stderr,
      });
      return undefined;
    }

    const parsed = JSON.parse(stdout) as { acpx?: { config_options?: Array<{ id?: unknown; category?: unknown }> } };
    const options = parsed.acpx?.config_options;
    const match = Array.isArray(options) ? options.find((o) => o?.category === THOUGHT_LEVEL_CATEGORY) : undefined;
    return typeof match?.id === "string" ? match.id : undefined;
  } catch (err) {
    // Covers both a rejected spawn() (e.g. transient IPC error) and a JSON.parse
    // failure — either way, discovery is best-effort and must not break session
    // creation. The caller falls back to the static map.
    getSafeLogger()?.debug("acp-adapter", "Effort option discovery failed; falling back to static map", {
      storyId,
      agentName,
      cause: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

export async function applyReasoningEffort(params: {
  effort: string | undefined;
  agentName: string;
  sessionName: string;
  cwd: string;
  storyId?: string;
  spawn: Spawn;
}): Promise<void> {
  const { effort, agentName, sessionName, cwd, storyId, spawn } = params;
  if (!effort) return;

  const optionName =
    (await discoverEffortOptionId({ agentName, sessionName, cwd, storyId, spawn })) ??
    EFFORT_OPTION_BY_AGENT[agentName];
  if (!optionName) {
    getSafeLogger()?.debug("acp-adapter", "Agent has no known effort option; skipping", {
      storyId,
      agentName,
      effort,
    });
    return;
  }

  const cmd = ["acpx", "--cwd", cwd, agentName, "set", optionName, effort, "-s", sessionName];
  const { exitCode, stdout, stderr } = await spawn(cmd);

  // Best-effort: a failure leaves the session at the adapter default rather than
  // failing the whole run. The warning is what keeps that downgrade visible.
  if (exitCode !== 0) {
    getSafeLogger()?.warn("acp-adapter", `Failed to set ${optionName}; continuing at adapter default`, {
      storyId,
      effort,
      session: sessionName,
      cause: stdout || stderr,
    });
  }
}
