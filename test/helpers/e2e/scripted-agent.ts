/**
 * E2E-only: a programmable AgentAdapter keyed by session role + per-role attempt.
 * Wraps makeAgentAdapter; recovers the role from `handle.role` (fallback: last
 * segment of the session id `nax-<hash>-<feat>-<story>-<role>`).
 */
import type { AgentAdapter, SessionHandle, TurnResult } from "@/agents/types";
import { makeAgentAdapter } from "../mock-agent-adapter";

export interface ScriptedTurn {
  output: string;
  estimatedCostUsd?: number;
}

export type ScriptedAgentSpec = Record<string, (attempt: number) => ScriptedTurn>;

function roleOf(handle: SessionHandle): string {
  if (handle.role) return handle.role;
  const parts = handle.id.split("-");
  return parts[parts.length - 1] ?? "main";
}

function toTurnResult(t: ScriptedTurn): TurnResult {
  return {
    output: t.output,
    tokenUsage: { inputTokens: 1, outputTokens: 1 },
    estimatedCostUsd: t.estimatedCostUsd ?? 0,
    internalRoundTrips: 1,
  };
}

const BENIGN: ScriptedTurn = { output: "{}", estimatedCostUsd: 0 };

export function makeScriptedAgent(spec: ScriptedAgentSpec): AgentAdapter {
  const attempts = new Map<string, number>();
  return makeAgentAdapter({
    sendTurn: async (handle, _prompt, _opts) => {
      const role = roleOf(handle);
      const n = attempts.get(role) ?? 0;
      attempts.set(role, n + 1);
      const fn = spec[role];
      return toTurnResult(fn ? fn(n) : BENIGN);
    },
  });
}
