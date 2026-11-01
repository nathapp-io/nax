/**
 * Agent hook loop handlers — the two tool events (US-004) and the factory that
 * builds the whole set.
 *
 * `createAgentHookHandlers` turns the `agent` section of `hooks.json` into a
 * `LoopHandlerSet` for ONE surface. Two decisions are load-bearing:
 *
 *   - **One handler per loop event, not one per entry.** `dispatchChain`
 *     (`@nathapp/nax-agent` `loop-events/registry.ts`) merges a handler's patch
 *     by overwrite, so two handlers that each answered a `before_turn` patch
 *     would keep only the last one's. The single handler runs every applicable
 *     entry itself, in config order, and combines their answers.
 *   - **Scope is filtered once, at construction.** An entry scoped `["run"]`
 *     never reaches the chat set, and an event with no surviving entry
 *     registers nothing — so an empty `hooks.json` adds no handler at all.
 *
 * `PreToolUse` maps to `before_tool`, `PostToolUse` to `after_tool`. A matcher
 * absent or `"*"` covers every tool; anything else is the anchored expression
 * `^(?:matcher)$`, because `Bash` must not match `BashOutput`.
 *
 * The turn events (`SessionStart`/`UserPromptSubmit` on `before_turn`, `Stop` on
 * `before_turn_end`) are built by `turn-handlers.ts` and registered by the same
 * factory — one set, one surface, not a second registration mechanism.
 *
 * **The deadline.** Each handler's `timeoutMs` is the margin plus one
 * `timeoutMs + kill grace + drain` budget per entry it may run. With that
 * bound a hook always reports its own timeout or error before the native
 * wrapper's generic deadline fires, so these handlers' per-event failure rules
 * — not the wrapper's — decide the outcome.
 *
 * **The call-input record.** `PostToolUse` needs the input the call actually
 * ran with, which only `before_tool` sees. The `before_tool` handler therefore
 * records it, keyed by session name and call id, when at least one
 * `PostToolUse` entry matches the tool. `after_tool` reads and deletes it on
 * every dispatch for that key — a post-only config still gets a record-only
 * `before_tool` entry for exactly this reason. The record is written after this
 * handler's own `updatedInput` rewrites, so a later plugin's rewrite is not
 * what the post hook is told about.
 */

import type {
  AfterToolPatch,
  AfterToolPayload,
  BeforeToolOutcome,
  BeforeToolPayload,
  ExternalHandlerOf,
  LoopEvent,
  LoopHandlerContext,
  LoopHandlerEntry,
  LoopHandlerSet,
  PayloadOf,
} from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import {
  _agentHookHandlerDeps,
  AGENT_HOOKS_PLUGIN,
  AGENT_HOOKS_STAGE,
  type AgentHookState,
  additionalContextOf,
  blockReason,
  CONTEXT_SEPARATOR,
  cwdFor,
  describeFailure,
  handlerDeadline,
  hookPayloadBase,
  isJsonObject,
  scopedEntries,
  surfaceEntries,
  warnHookProblem,
} from "./common";
import { turnHookEntries } from "./turn-handlers";
import type { AgentHookEntry, AgentHookRun, AgentHookSurface, AgentHooksConfig } from "./types";

/** The config events these handlers serve. */
const PRE_TOOL_EVENT = "PreToolUse";
const POST_TOOL_EVENT = "PostToolUse";

/** Prefix on a `PreToolUse` refusal. */
const AGENT_HOOK_BLOCK_PREFIX = "Blocked by hook: ";

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the surface's handler set: at most one handler per loop event, each
 * carrying the deadline that covers every entry it may run. An empty config —
 * or a config whose entries are all scoped elsewhere — yields an empty set.
 */
export function createAgentHookHandlers(input: {
  readonly config: AgentHooksConfig;
  readonly surface: AgentHookSurface;
  readonly repoRoot: string;
}): LoopHandlerSet {
  const state: AgentHookState = {
    surface: input.surface,
    repoRoot: input.repoRoot,
    sessionStart: surfaceEntries(input.config.SessionStart, input.surface),
    promptSubmit: surfaceEntries(input.config.UserPromptSubmit, input.surface),
    stop: surfaceEntries(input.config.Stop, input.surface),
    preTool: scopedEntries(input.config.PreToolUse, input.surface),
    postTool: scopedEntries(input.config.PostToolUse, input.surface),
    records: new Map(),
  };
  const entries: LoopHandlerEntry[] = [];
  // A post-only config still needs `before_tool`: it is what records the input
  // the `PostToolUse` hook is told the call ran with. Nothing else to do here
  // means the handler runs no entry, so its deadline is the margin alone.
  if (state.preTool.length > 0 || state.postTool.length > 0) {
    entries.push({
      plugin: AGENT_HOOKS_PLUGIN,
      event: "before_tool",
      timeoutMs: handlerDeadline(state.preTool.map((hook) => hook.entry)),
      handler: beforeToolHandler(state),
    });
  }
  if (state.postTool.length > 0) {
    entries.push({
      plugin: AGENT_HOOKS_PLUGIN,
      event: "after_tool",
      timeoutMs: handlerDeadline(state.postTool.map((hook) => hook.entry)),
      handler: afterToolHandler(state),
    });
  }
  entries.push(...turnHookEntries(state));
  return Object.freeze(entries);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

function beforeToolHandler(state: AgentHookState): ExternalHandlerOf<LoopEvent> {
  return async (payload, ctx) => {
    if (!isBeforeToolPayload(payload)) return { kind: "allow" };
    return runPreToolHooks(state, payload, ctx);
  };
}

function afterToolHandler(state: AgentHookState): ExternalHandlerOf<LoopEvent> {
  return async (payload, ctx) => {
    if (!isAfterToolPayload(payload)) return undefined;
    return runPostToolHooks(state, payload, ctx);
  };
}

/** Only `before_tool`'s payload carries a tool call; it is what this event reads. */
function isBeforeToolPayload(payload: PayloadOf<LoopEvent>): payload is BeforeToolPayload {
  return "call" in payload;
}

/** Only `after_tool`'s payload carries the finished call's result content. */
function isAfterToolPayload(payload: PayloadOf<LoopEvent>): payload is AfterToolPayload {
  return "content" in payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// PreToolUse → before_tool
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one entry's answer asked for, once its run is interpreted:
 * a decision that stops the chain, or a rewrite and/or context to carry on with.
 */
type PreToolStep =
  | { readonly kind: "blocked"; readonly outcome: BeforeToolOutcome }
  | { readonly kind: "ok"; readonly input?: Record<string, unknown>; readonly context?: string };

/**
 * Run every matching `PreToolUse` entry in config order.
 *
 * The accumulated rewrite is what each later entry is told the call's input is,
 * and what the loop runs — so a hook that corrects a command is never silently
 * discarded by a later one. The first block (or error) wins and stops the
 * chain: a refused call is not a call the rest may judge. The rewritten input
 * is recorded for `after_tool` before returning, because the result that
 * arrives there belongs to the input that actually ran.
 */
async function runPreToolHooks(
  state: AgentHookState,
  payload: BeforeToolPayload,
  ctx: LoopHandlerContext,
): Promise<BeforeToolOutcome> {
  const toolName = payload.call.name;
  const cwd = cwdFor(state, ctx);
  const notes: string[] = [];
  let input = payload.call.input;
  let rewritten: Record<string, unknown> | undefined;

  for (const hook of state.preTool) {
    if (!hook.matches(toolName)) continue;
    const run = await _agentHookHandlerDeps.runAgentHook({
      entry: hook.entry,
      payload: toolHookPayload({ state, ctx, cwd, event: PRE_TOOL_EVENT, toolName, input }),
      cwd,
    });
    const step = interpretPreToolRun(hook.entry, run);
    if (step.kind === "blocked") return step.outcome;
    if (step.input !== undefined) {
      input = step.input;
      rewritten = step.input;
    }
    if (step.context !== undefined) notes.push(step.context);
  }

  rememberCallInput(state, ctx, { id: payload.call.id, toolName, input });
  return combinePreToolAnswers(rewritten, notes);
}

/** The outcome a chain's accumulated rewrite and context strings make. */
function combinePreToolAnswers(
  rewritten: Record<string, unknown> | undefined,
  notes: readonly string[],
): BeforeToolOutcome {
  const text = notes.join(CONTEXT_SEPARATOR);
  if (text.length > 0)
    return rewritten === undefined ? { kind: "nudge", text } : { kind: "nudge", text, input: rewritten };
  return rewritten === undefined ? { kind: "allow" } : { kind: "allow", input: rewritten };
}

/**
 * One entry's run as a step. `block` refuses the call; an `error` fails CLOSED —
 * a guard that could not run must never read as a silent allow. Only a `block`
 * decision, `updatedInput` and `additionalContext` are read: plain stdout is
 * not context for a tool event, and a JSON object is never plain text.
 */
function interpretPreToolRun(entry: AgentHookEntry, run: AgentHookRun): PreToolStep {
  if (run.kind === "block") return blockedStep(run.reason);
  if (run.kind === "error") {
    return {
      kind: "blocked",
      outcome: {
        kind: "block",
        isError: true,
        content: `${AGENT_HOOK_BLOCK_PREFIX}${describeFailure(entry, run.reason)}`,
      },
    };
  }
  const json = run.json;
  if (json === undefined) return { kind: "ok" };
  if (json.decision === "block") return blockedStep(blockReason(json, entry));

  const rewrite = updatedInputOf(entry, json.updatedInput);
  const context = additionalContextOf(json);
  return {
    kind: "ok",
    ...(rewrite !== undefined ? { input: rewrite } : {}),
    ...(context !== undefined ? { context } : {}),
  };
}

function blockedStep(reason: string): PreToolStep {
  return { kind: "blocked", outcome: { kind: "block", content: `${AGENT_HOOK_BLOCK_PREFIX}${reason}` } };
}

/**
 * A `updatedInput` rewrite, when it is one. A JSON object is the contract;
 * anything else (a string, an array, `null`) is ignored with one warning naming
 * the hook, because substituting a non-object would hand the tool a malformed
 * input in place of the model's valid one.
 */
function updatedInputOf(entry: AgentHookEntry, updated: unknown): Record<string, unknown> | undefined {
  if (updated === undefined) return undefined;
  if (isJsonObject(updated)) return updated;
  warnHookProblem(entry, "its updatedInput is not a JSON object, so the input is unchanged");
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// PostToolUse → after_tool
// ─────────────────────────────────────────────────────────────────────────────

/** `"\n\n"` before each block of text a post hook appends to the result. */
const RESULT_APPEND_SEPARATOR = "\n\n";

/** Prefix on a `PostToolUse` block. */
const FEEDBACK_PREFIX = "Hook feedback: ";

/** Prefix on a `PostToolUse` `additionalContext`. */
const CONTEXT_PREFIX = "Hook context: ";

/**
 * Append every matching `PostToolUse` entry's feedback to the finished result.
 *
 * A post hook cannot block: the call already ran, so its refusal is information
 * the model reads — a `block` run, or a JSON `decision: "block"`, becomes
 * "Hook feedback: …" and `additionalContext` becomes "Hook context: …", in
 * entry order. An error contributes nothing and warns once: a broken formatter
 * must not rewrite a result the tool produced. No text at all means no patch —
 * `undefined`, so the loop leaves the result exactly as it was.
 *
 * The recorded input is taken first, on every dispatch for that key, whether or
 * not an entry runs and whether or not it answers.
 */
async function runPostToolHooks(
  state: AgentHookState,
  payload: AfterToolPayload,
  ctx: LoopHandlerContext,
): Promise<AfterToolPatch | undefined> {
  const recorded = takeCallInput(state, ctx.sessionName, payload.callId);
  const toolName = payload.toolName;
  if (toolName === undefined) return undefined;
  const hooks = state.postTool.filter((hook) => hook.matches(toolName));
  if (hooks.length === 0) return undefined;

  const cwd = cwdFor(state, ctx);
  const response = { content: payload.content, is_error: payload.isError ?? false };
  const appended: string[] = [];
  for (const hook of hooks) {
    const run = await _agentHookHandlerDeps.runAgentHook({
      entry: hook.entry,
      payload: toolHookPayload({ state, ctx, cwd, event: POST_TOOL_EVENT, toolName, input: recorded, response }),
      cwd,
    });
    appended.push(...resultAdditions(hook.entry, run));
  }
  return appended.length === 0 ? undefined : { content: payload.content + appended.join("") };
}

/**
 * What one entry's answer appends to the result, each block already carrying
 * its separator. Only a `block` decision/reason and `additionalContext` are
 * read — plain stdout is not feedback for a tool event, and a JSON object is
 * never plain text.
 */
function resultAdditions(entry: AgentHookEntry, run: AgentHookRun): string[] {
  if (run.kind === "error") {
    warnPostToolFailure(entry, run.reason);
    return [];
  }
  if (run.kind === "block") return [RESULT_APPEND_SEPARATOR + FEEDBACK_PREFIX + run.reason];

  const json = run.json;
  if (json === undefined) return [];
  const additions: string[] = [];
  if (json.decision === "block") {
    additions.push(RESULT_APPEND_SEPARATOR + FEEDBACK_PREFIX + blockReason(json, entry));
  }
  const context = additionalContextOf(json);
  if (context !== undefined) additions.push(RESULT_APPEND_SEPARATOR + CONTEXT_PREFIX + context);
  return additions;
}

/** A post hook's failure is the hook's, not the result's: warn and move on. */
function warnPostToolFailure(entry: AgentHookEntry, reason: string): void {
  getLogger().warn(AGENT_HOOKS_STAGE, `Agent hook "${entry.command}" failed on PostToolUse; the result is unchanged`, {
    command: entry.command,
    event: POST_TOOL_EVENT,
    error: reason,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The call-input record the two events share
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The most call inputs one session keeps waiting for their `after_tool`.
 *
 * A call blocked by a later plugin, one that throws, or one abandoned by an
 * aborted turn never reaches `after_tool`, so its record is never taken. The
 * cap bounds that residue for a long chat; the oldest record goes first, and a
 * call that old has no result coming.
 */
export const AGENT_HOOK_MAX_RECORDED_CALLS = 256;

/**
 * Record the input this call will run with for `after_tool`, which cannot see
 * the call. Written only when a `PostToolUse` entry covers the tool, so a
 * `PreToolUse`-only config keeps no state at all.
 */
function rememberCallInput(
  state: AgentHookState,
  ctx: LoopHandlerContext,
  call: { readonly id: string; readonly toolName: string; readonly input: unknown },
): void {
  if (!state.postTool.some((hook) => hook.matches(call.toolName))) return;
  const existing = state.records.get(ctx.sessionName);
  const byCallId = existing ?? new Map<string, unknown>();
  if (existing === undefined) state.records.set(ctx.sessionName, byCallId);
  byCallId.delete(call.id);
  byCallId.set(call.id, call.input);
  // Map iteration is insertion order, so the first key is the oldest record.
  const oldest = byCallId.keys().next();
  if (byCallId.size > AGENT_HOOK_MAX_RECORDED_CALLS && oldest.done !== true) byCallId.delete(oldest.value);
}

/**
 * Read and delete one call's recorded input. The delete happens on EVERY
 * `after_tool` dispatch for the key, whether or not a hook runs, so a result
 * answered more than once cannot replay a stale input.
 */
function takeCallInput(state: AgentHookState, sessionName: string, callId: string | undefined): unknown {
  if (callId === undefined) return undefined;
  const byCallId = state.records.get(sessionName);
  if (byCallId === undefined) return undefined;
  const input = byCallId.get(callId);
  byCallId.delete(callId);
  if (byCallId.size === 0) state.records.delete(sessionName);
  return input;
}

// ─────────────────────────────────────────────────────────────────────────────
// The payload every tool event hands over
// ─────────────────────────────────────────────────────────────────────────────

interface ToolPayloadInput {
  readonly state: AgentHookState;
  readonly ctx: LoopHandlerContext;
  readonly cwd: string;
  readonly event: typeof PRE_TOOL_EVENT | typeof POST_TOOL_EVENT;
  readonly toolName: string;
  readonly input: unknown;
  readonly response?: { readonly content: string; readonly is_error: boolean };
}

/**
 * One payload for both tool events: the shared facts every event carries, the
 * tool name, the call's input (omitted when there is none to report) and, on
 * `after_tool`, the result the hook is being shown.
 */
function toolHookPayload(action: ToolPayloadInput): Readonly<Record<string, unknown>> {
  const { state, ctx, cwd, event, toolName, input, response } = action;
  return {
    ...hookPayloadBase({ state, ctx, cwd, event }),
    tool_name: toolName,
    ...(input !== undefined ? { tool_input: input } : {}),
    ...(response !== undefined ? { tool_response: response } : {}),
  };
}
