/**
 * E2E-only: a programmable AgentAdapter keyed by session role + per-role attempt.
 * Wraps makeAgentAdapter; recovers the role from `handle.role` (fallback: matching
 * a known session role at the tail of the session id
 * `nax-<hash>-<feat>-<story>-<role>`).
 */
import type { AgentAdapter, SessionHandle, TurnResult } from "@/agents/types";
import { KNOWN_SESSION_ROLES, isSessionRole } from "@/runtime";
import type { SessionRole } from "@/runtime";
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

/**
 * Extract the session role from a session name following the nax naming convention:
 * `nax-<hash8>-<feature>-<storyId>-<sessionRole>`.
 *
 * The role may itself contain hyphens (e.g. `reviewer-adversarial`). We match by
 * trying each known canonical role as a suffix of the session name, longest-first,
 * to avoid `reviewer` matching before `reviewer-adversarial`.
 *
 * Returns "main" when no known role matches (safe fallback).
 */
function roleFromSessionName(sessionName: string): SessionRole {
  // Sort by length descending so longer roles (e.g. "reviewer-adversarial") match
  // before shorter prefixes (e.g. "reviewer") when both could be a suffix.
  const sorted = [...KNOWN_SESSION_ROLES].sort((a, b) => b.length - a.length);
  for (const role of sorted) {
    if (sessionName.endsWith(`-${role}`)) return role;
  }
  // Fallback: debate roles — check for "debate-" suffix pattern.
  const debateMatch = sessionName.match(/-?(debate-[^-]+)$/);
  if (debateMatch?.[1] && isSessionRole(debateMatch[1])) return debateMatch[1] as SessionRole;
  return "main";
}

export function makeScriptedAgent(spec: ScriptedAgentSpec): AgentAdapter {
  const attempts = new Map<string, number>();
  return makeAgentAdapter({
    // Override openSession to embed the role parsed from the session name into the
    // returned handle. roleOf() reads handle.role first, so this ensures the
    // correct spec key is used in sendTurn without fragile string parsing there.
    openSession: async (sessionName, _opts) => ({
      id: sessionName,
      agentName: "scripted",
      role: roleFromSessionName(sessionName),
    }),
    sendTurn: async (handle, _prompt, _opts) => {
      const role = roleOf(handle);
      const n = attempts.get(role) ?? 0;
      attempts.set(role, n + 1);
      const fn = spec[role];
      return toTurnResult(fn ? fn(n) : BENIGN);
    },
  });
}
