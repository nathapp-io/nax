/**
 * What the agent-hook handlers share (US-004, US-005).
 *
 * Three things live here because both handler groups need them and neither may
 * own them: the surface filter, the deadline formula, and the payload facts
 * every event carries on stdin. The rest is the reading of a hook's answer that
 * does not depend on the event — a block's reason, a JSON object's
 * `additionalContext`, and what a failure says.
 *
 * Splitting them out is not cosmetic: `handlers.ts` (the tool events) and
 * `turn-handlers.ts` (the turn events) both read them, and importing one from
 * the other would close a runtime import cycle that `check:import-cycles`
 * rejects.
 */

import type { LoopHandlerContext } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { AGENT_HOOK_DRAIN_MS, AGENT_HOOK_HANDLER_MARGIN_MS, AGENT_HOOK_KILL_GRACE_MS, runAgentHook } from "./run-hook";
import type { AgentHookEntry, AgentHookSurface } from "./types";

/** The plugin name every entry this factory registers carries. */
export const AGENT_HOOKS_PLUGIN = "agent-hooks";

/** Logger stage, shared with `run-hook.ts`. */
export const AGENT_HOOKS_STAGE = "agent-hooks";

/** Between the context strings several entries contribute. */
export const CONTEXT_SEPARATOR = "\n\n";

/** The matcher value that covers every tool. */
const MATCH_ALL_TOOLS = "*";

/** Injectable for tests; read at call time, never captured at import. */
export const _agentHookHandlerDeps: { runAgentHook: typeof runAgentHook } = { runAgentHook };

/** One entry that survived the surface filter, with its matcher compiled once. */
export interface ScopedHook {
  readonly entry: AgentHookEntry;
  /** Whether the entry's matcher covers this tool name. */
  matches(toolName: string): boolean;
}

/** Everything the handlers close over for the life of the factory. */
export interface AgentHookState {
  readonly surface: AgentHookSurface;
  readonly repoRoot: string;
  readonly sessionStart: readonly AgentHookEntry[];
  readonly promptSubmit: readonly AgentHookEntry[];
  readonly stop: readonly AgentHookEntry[];
  readonly preTool: readonly ScopedHook[];
  readonly postTool: readonly ScopedHook[];
  /** Recorded call inputs: session name, then call id (US-004). */
  readonly records: Map<string, Map<string, unknown>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope and deadlines
// ─────────────────────────────────────────────────────────────────────────────

/** The entries of one event this surface runs, in config order. */
export function surfaceEntries(entries: readonly AgentHookEntry[], surface: AgentHookSurface): AgentHookEntry[] {
  return entries.filter((entry) => entry.scope.includes(surface));
}

/** The tool-event entries this surface runs, with each matcher compiled once. */
export function scopedEntries(entries: readonly AgentHookEntry[], surface: AgentHookSurface): ScopedHook[] {
  return surfaceEntries(entries, surface).map((entry) => ({ entry, matches: compileMatcher(entry.matcher) }));
}

/**
 * A matcher as a whole-name predicate. Absent and `"*"` cover every tool;
 * anything else is anchored, so `Bash` never matches `BashOutput`.
 */
function compileMatcher(matcher: string | undefined): (toolName: string) => boolean {
  if (matcher === undefined || matcher === MATCH_ALL_TOOLS) return () => true;
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${matcher})$`);
  } catch {
    // The loader rejects an uncompilable matcher with a warning of its own. A
    // config assembled by hand can still carry one, and a hook whose matcher
    // cannot be evaluated must not run for every call.
    getLogger().warn(AGENT_HOOKS_STAGE, `Ignoring agent hook with an uncompilable matcher "${matcher}"`, { matcher });
    return () => false;
  }
  return (toolName) => pattern.test(toolName);
}

/**
 * The handler's deadline: its own bookkeeping margin plus, per entry it may
 * run, the entry's timeout and the two bounds `run-hook.ts` adds on top of it
 * (SIGTERM to SIGKILL, then stream drain). The hook therefore times out first
 * and these handlers, not the native wrapper, decide what a failure means.
 */
export function handlerDeadline(entries: readonly AgentHookEntry[]): number {
  return entries.reduce(
    (total, entry) => total + entry.timeoutMs + AGENT_HOOK_KILL_GRACE_MS + AGENT_HOOK_DRAIN_MS,
    AGENT_HOOK_HANDLER_MARGIN_MS,
  );
}

/** The hook runs where the session works, else in the repository it belongs to. */
export function cwdFor(state: AgentHookState, ctx: LoopHandlerContext): string {
  return ctx.workdir ?? state.repoRoot;
}

// ─────────────────────────────────────────────────────────────────────────────
// The payload every event hands over
// ─────────────────────────────────────────────────────────────────────────────

interface PayloadBaseInput {
  readonly state: AgentHookState;
  readonly ctx: LoopHandlerContext;
  readonly cwd: string;
  readonly event: string;
}

/**
 * The facts every hook event carries. What one event adds on top (the tool
 * name, the prompt, whether a follow-up is already running) is the caller's.
 */
export function hookPayloadBase(input: PayloadBaseInput): Readonly<Record<string, unknown>> {
  const { state, ctx, cwd, event } = input;
  return {
    hook_event_name: event,
    session_id: ctx.sessionName,
    cwd,
    surface: state.surface,
    ...(ctx.role !== undefined ? { role: ctx.role } : {}),
    ...(ctx.feature !== undefined ? { feature: ctx.feature } : {}),
    ...(ctx.storyId !== undefined ? { story_id: ctx.storyId } : {}),
    ...(ctx.model !== undefined ? { model: ctx.model } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading an answer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reason a `decision: "block"` answers with. Without one the refusal still
 * has to say which hook answered, so the command stands in for it.
 */
export function blockReason(json: Readonly<Record<string, unknown>>, entry: AgentHookEntry): string {
  const { reason } = json;
  return typeof reason === "string" && reason.length > 0 ? reason : `blocked by hook '${entry.command}'`;
}

/** A non-empty `additionalContext` string, or undefined. */
export function additionalContextOf(json: Readonly<Record<string, unknown>>): string | undefined {
  const { additionalContext } = json;
  return typeof additionalContext === "string" && additionalContext.length > 0 ? additionalContext : undefined;
}

/** True for a plain JSON object — an array and `null` are not objects here. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Why a hook's own failure changed the outcome, naming the hook that failed. */
export function describeFailure(entry: AgentHookEntry, reason: string): string {
  return `agent hook "${entry.command}" failed (${reason})`;
}

/** One warning for an answer that is ignored; naming the hook is the point. */
export function warnHookProblem(entry: AgentHookEntry, reason: string): void {
  getLogger().warn(AGENT_HOOKS_STAGE, `Agent hook "${entry.command}" was ignored: ${reason}`, {
    command: entry.command,
    reason,
  });
}

/** One warning for a turn event whose answer changes nothing (US-005). */
export function warnTurnHookIgnored(entry: AgentHookEntry, event: string, reason: string): void {
  getLogger().warn(AGENT_HOOKS_STAGE, `Agent hook "${entry.command}" was ignored on ${event}: ${reason}`, {
    command: entry.command,
    event,
    reason,
  });
}
