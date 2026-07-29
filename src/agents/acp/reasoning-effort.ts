/**
 * Reasoning-effort application for codex sessions.
 *
 * acpx 0.13+ selects codex models through the config-option channel, where the
 * model id is bare and effort is a sibling option. --model is re-sent on every
 * prompt, but effort has no per-prompt carrier, so it is set once when a session
 * is acquired.
 *
 * Lives outside spawn-client.ts deliberately: that file is at its file-size
 * ratchet ceiling, and a free function with an injected spawn is unit-testable
 * without constructing a client.
 */

import { getSafeLogger } from "@/logger";

export async function applyReasoningEffort(params: {
  effort: string | undefined;
  agentName: string;
  sessionName: string;
  cwd: string;
  storyId?: string;
  spawn: (cmd: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): Promise<void> {
  const { effort, agentName, sessionName, cwd, storyId, spawn } = params;
  if (!effort) return;

  const cmd = ["acpx", "--cwd", cwd, agentName, "set", "reasoning_effort", effort, "-s", sessionName];
  const { exitCode, stdout, stderr } = await spawn(cmd);

  // Best-effort: a failure leaves the session at the adapter default rather than
  // failing the whole run. The warning is what keeps that downgrade visible.
  if (exitCode !== 0) {
    getSafeLogger()?.warn("acp-adapter", "Failed to set reasoning_effort; continuing at adapter default", {
      storyId,
      effort,
      session: sessionName,
      cause: stdout || stderr,
    });
  }
}
