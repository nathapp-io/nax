/**
 * Agent hook loop handlers for the turn events (US-005).
 *
 * `SessionStart` and `UserPromptSubmit` are ONE handler on `before_turn`, and
 * `Stop` is the `before_turn_end` handler. One handler per event is forced by
 * `dispatchChain`: it merges a handler's patch by overwrite, so two `before_turn`
 * handlers would keep only the last one's answer. `SessionStart` runs first and
 * only on a turn whose loaded `history` is empty — the session's first turn.
 *
 * The handlers produce patches, never messages: `promptContext` is prefixed to
 * the turn's prompt by the native loop, and a `block` refuses it before anything
 * is persisted. The stop handler returns `followUp` and relies on the loop's own
 * `MAX_FOLLOW_UPS_PER_TURN` cap — it never bypasses it.
 */

import type {
  BeforeTurnEndPatch,
  BeforeTurnEndPayload,
  BeforeTurnPatch,
  BeforeTurnPayload,
  ExternalHandlerOf,
  LoopEvent,
  LoopHandlerContext,
  LoopHandlerEntry,
  PayloadOf,
} from "@nathapp/nax-agent/internal";
import {
  _agentHookHandlerDeps,
  AGENT_HOOKS_PLUGIN,
  type AgentHookState,
  additionalContextOf,
  blockReason,
  CONTEXT_SEPARATOR,
  cwdFor,
  describeFailure,
  handlerDeadline,
  hookPayloadBase,
  warnTurnHookIgnored,
} from "./common";
import type { AgentHookEntry, AgentHookRun, AgentHookSurface } from "./types";

/** The config events these handlers serve. */
const SESSION_START_EVENT = "SessionStart";
const PROMPT_SUBMIT_EVENT = "UserPromptSubmit";
const STOP_EVENT = "Stop";

/** The surface with a human in front of it; a failed prompt hook blocks only there. */
const CHAT_SURFACE: AgentHookSurface = "chat";

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The turn events' entries for this surface: at most one `before_turn` and one
 * `before_turn_end`, each carrying the deadline that covers every entry it may
 * run. `SessionStart` counts towards `before_turn`'s deadline whether or not it
 * runs on a given turn, because the handler may run it.
 */
export function turnHookEntries(state: AgentHookState): LoopHandlerEntry[] {
  const entries: LoopHandlerEntry[] = [];
  const turnEntries = [...state.sessionStart, ...state.promptSubmit];
  if (turnEntries.length > 0) {
    entries.push({
      plugin: AGENT_HOOKS_PLUGIN,
      event: "before_turn",
      timeoutMs: handlerDeadline(turnEntries),
      handler: beforeTurnHandler(state),
    });
  }
  if (state.stop.length > 0) {
    entries.push({
      plugin: AGENT_HOOKS_PLUGIN,
      event: "before_turn_end",
      timeoutMs: handlerDeadline(state.stop),
      handler: beforeTurnEndHandler(state),
    });
  }
  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// before_turn — SessionStart, then UserPromptSubmit
// ─────────────────────────────────────────────────────────────────────────────

function beforeTurnHandler(state: AgentHookState): ExternalHandlerOf<LoopEvent> {
  return async (payload, ctx) => {
    if (!isBeforeTurnPayload(payload)) return undefined;
    return runTurnHooks(state, payload, ctx);
  };
}

/** Only `before_turn`'s payload carries the prompt and the loaded history. */
function isBeforeTurnPayload(payload: PayloadOf<LoopEvent>): payload is BeforeTurnPayload {
  return "prompt" in payload && "history" in payload;
}

/**
 * `SessionStart` on a first turn, then every `UserPromptSubmit` entry.
 *
 * `SessionStart` runs on an empty loaded history even when a `UserPromptSubmit`
 * hook blocked the previous turn: a blocked prompt was never persisted, so the
 * session's context hook has still never seen it.
 */
async function runTurnHooks(
  state: AgentHookState,
  payload: BeforeTurnPayload,
  ctx: LoopHandlerContext,
): Promise<BeforeTurnPatch | undefined> {
  const cwd = cwdFor(state, ctx);
  const notes: string[] =
    payload.history.length === 0 ? await runSessionStartHooks(state.sessionStart, state, ctx, cwd) : [];
  const prompt = await runPromptHooks(state.promptSubmit, state, payload.prompt, ctx, cwd);
  // A refusal is the whole answer: the accumulated context is dropped with the
  // prompt it was meant to accompany.
  if (prompt.block !== undefined) return { block: { reason: prompt.block } };
  return contextPatch([...notes, ...prompt.notes]);
}

/** The patch a turn's accumulated context makes; nothing to add changes nothing. */
function contextPatch(notes: readonly string[]): BeforeTurnPatch | undefined {
  const text = notes.filter((note) => note.length > 0).join(CONTEXT_SEPARATOR);
  return text.length === 0 ? undefined : { promptContext: text };
}

/** Run every `SessionStart` entry, in config order, collecting its context. */
async function runSessionStartHooks(
  entries: readonly AgentHookEntry[],
  state: AgentHookState,
  ctx: LoopHandlerContext,
  cwd: string,
): Promise<string[]> {
  const notes: string[] = [];
  for (const entry of entries) {
    const run = await _agentHookHandlerDeps.runAgentHook({
      entry,
      payload: hookPayloadBase({ state, ctx, cwd, event: SESSION_START_EVENT }),
      cwd,
    });
    const context = sessionStartContext(entry, run);
    if (context !== undefined) notes.push(context);
  }
  return notes;
}

/**
 * A `SessionStart` entry's context. This event cannot block — the turn has not
 * started and there is nothing to refuse — and a failure changes nothing, so
 * both are one warning and no context.
 */
function sessionStartContext(entry: AgentHookEntry, run: AgentHookRun): string | undefined {
  if (run.kind === "block") {
    warnTurnHookIgnored(entry, SESSION_START_EVENT, "a SessionStart hook cannot block a turn");
    return undefined;
  }
  if (run.kind === "error") {
    warnTurnHookIgnored(entry, SESSION_START_EVENT, run.reason);
    return undefined;
  }
  return answerContext(run);
}

/**
 * Context from a successful run. A JSON-object stdout is NEVER plain text — an
 * answer of `{}` says nothing — so only `additionalContext` counts then;
 * otherwise the plain stdout is the context.
 */
function answerContext(run: AgentHookRun): string | undefined {
  if (run.kind !== "ok") return undefined;
  if (run.json !== undefined) return additionalContextOf(run.json);
  return run.stdout.length > 0 ? run.stdout : undefined;
}

/** What a run of the `UserPromptSubmit` entries answered. */
interface PromptOutcome {
  /** The context strings the entries added, in order. */
  readonly notes: readonly string[];
  /** Why the prompt is refused, when an entry refused it. */
  readonly block?: string;
}

/**
 * Run every `UserPromptSubmit` entry, in config order, until one refuses the
 * prompt: a refused prompt is not a prompt the remaining hooks may judge, and
 * the entries after it do not run.
 */
async function runPromptHooks(
  entries: readonly AgentHookEntry[],
  state: AgentHookState,
  prompt: string,
  ctx: LoopHandlerContext,
  cwd: string,
): Promise<PromptOutcome> {
  const notes: string[] = [];
  for (const entry of entries) {
    const run = await _agentHookHandlerDeps.runAgentHook({
      entry,
      payload: { ...hookPayloadBase({ state, ctx, cwd, event: PROMPT_SUBMIT_EVENT }), prompt },
      cwd,
    });
    const step = interpretPromptRun(state, entry, run);
    if (step.kind === "blocked") return { notes, block: step.reason };
    if (step.context !== undefined) notes.push(step.context);
  }
  return { notes };
}

/** What one `UserPromptSubmit` entry's run asked for. */
type PromptStep =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "ok"; readonly context?: string };

/**
 * One entry's run as a step. A `block` run and a JSON `decision: "block"` both
 * refuse the prompt; everything else contributes context, if it said anything.
 */
function interpretPromptRun(state: AgentHookState, entry: AgentHookEntry, run: AgentHookRun): PromptStep {
  if (run.kind === "block") return { kind: "blocked", reason: run.reason };
  if (run.kind === "error") return promptFailureStep(state.surface, entry, run.reason);
  const json = run.json;
  if (json !== undefined && json.decision === "block") return { kind: "blocked", reason: blockReason(json, entry) };
  const context = answerContext(run);
  return context === undefined ? { kind: "ok" } : { kind: "ok", context };
}

/**
 * A failed prompt hook on `chat` refuses the prompt: a human is there to read
 * why. On `run` it is let through with a warning, so a broken script cannot
 * fail stories in an unattended run.
 */
function promptFailureStep(surface: AgentHookSurface, entry: AgentHookEntry, reason: string): PromptStep {
  if (surface === CHAT_SURFACE) return { kind: "blocked", reason: describeFailure(entry, reason) };
  warnTurnHookIgnored(entry, PROMPT_SUBMIT_EVENT, reason);
  return { kind: "ok" };
}

// ─────────────────────────────────────────────────────────────────────────────
// before_turn_end — Stop
// ─────────────────────────────────────────────────────────────────────────────

function beforeTurnEndHandler(state: AgentHookState): ExternalHandlerOf<LoopEvent> {
  return async (payload, ctx) => {
    if (!isBeforeTurnEndPayload(payload)) return undefined;
    return runStopHooks(state, payload, ctx);
  };
}

/** Only `before_turn_end`'s payload carries how the turn ended. */
function isBeforeTurnEndPayload(payload: PayloadOf<LoopEvent>): payload is BeforeTurnEndPayload {
  return "ended" in payload && "followUpsSoFar" in payload;
}

/**
 * `Stop` is offered only on a turn that completed on its own. A turn ended by a
 * stop already had its continuation, and one that aborted or errored is not a
 * turn a hook may push forward — the loop ignores a follow-up there anyway.
 */
async function runStopHooks(
  state: AgentHookState,
  payload: BeforeTurnEndPayload,
  ctx: LoopHandlerContext,
): Promise<BeforeTurnEndPatch | undefined> {
  if (payload.ended !== "completed" || payload.stopped) return undefined;
  const cwd = cwdFor(state, ctx);
  for (const entry of state.stop) {
    const run = await _agentHookHandlerDeps.runAgentHook({
      entry,
      payload: {
        ...hookPayloadBase({ state, ctx, cwd, event: STOP_EVENT }),
        stop_hook_active: payload.followUpsSoFar > 0,
      },
      cwd,
    });
    const followUp = stopFollowUp(entry, run);
    // The first entry that asks to continue wins; the rest do not run, because
    // there is one continuation to offer and it is already chosen.
    if (followUp !== undefined) return { followUp };
  }
  return undefined;
}

/**
 * What one `Stop` entry's run asks for. Only a `block` — a run, or a JSON
 * `decision: "block"` — continues the turn; plain stdout is not a reason, and a
 * failure changes nothing.
 */
function stopFollowUp(entry: AgentHookEntry, run: AgentHookRun): string | undefined {
  if (run.kind === "error") {
    warnTurnHookIgnored(entry, STOP_EVENT, run.reason);
    return undefined;
  }
  if (run.kind === "block") return run.reason;
  const json = run.json;
  if (json === undefined || json.decision !== "block") return undefined;
  return blockReason(json, entry);
}
