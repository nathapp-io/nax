/**
 * The chat turn status as data: what the turn is doing right now, how long it has run
 * and how many tokens it has spent. `reduceTurnStatus` folds a session event stream into
 * it; `shortModel` and `formatTokens` are the display helpers the footer and the working
 * line share (US-016). `footerModel` composes the screen's one-line footer from a host
 * state, that status and the hint the screen is offering (US-017).
 *
 * Everything here is pure. A status the event does not change is returned as the same
 * object, so a component that compares by reference does no needless work.
 */
import type { SessionEvent } from "@nathapp/nax-agent";
import type { ChatHostState } from "@/chat";
import { type Span, type StyledLine, sanitizeText } from "./styled-line";
import { type ChatColorToken, resolveChatTheme } from "./theme";

/** What the turn is doing. Only meaningful while `running`. */
export type TurnPhase = "thinking" | "writing" | "tool" | "approval" | "compacting" | "retrying";

export interface TurnStatus {
  readonly running: boolean;
  readonly startedAt?: string;
  readonly phase: TurnPhase;
  readonly toolName?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** input + cacheRead + cacheWrite of the latest usage event; survives turn_end. */
  readonly contextTokens?: number;
}

/** No turn has run. `phase` is only read while `running`, so its value here is inert. */
export const IDLE_STATUS: TurnStatus = {
  running: false,
  phase: "thinking",
  inputTokens: 0,
  outputTokens: 0,
};

const THINKING: TurnPhase = "thinking";
const WRITING: TurnPhase = "writing";
const TOOL: TurnPhase = "tool";
const APPROVAL: TurnPhase = "approval";
const COMPACTING: TurnPhase = "compacting";
const RETRYING: TurnPhase = "retrying";

const TOKEN_UNIT = 1000;
const TOKEN_DECIMALS = 1;
const TOKEN_SUFFIX = "k";

/** A model name longer than this is elided; `SHORT_MODEL_KEEP` plus the ellipsis fills it. */
const SHORT_MODEL_MAX = 24;
const SHORT_MODEL_KEEP = 23;
const ELLIPSIS = "…";
const MODEL_PATH_SEPARATOR = "/";

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

function stringField(source: unknown, field: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = Reflect.get(source, field);
  return typeof value === "string" ? value : undefined;
}

/** A nested call is tagged with the running agent's task; its events do not drive the turn status. */
function isSubagentEvent(event: SessionEvent): boolean {
  return stringField(event.metadata, "subagentTask") !== undefined;
}

/** The status in `phase`; the tool name is set when one is given and cleared otherwise. */
function inPhase(status: TurnStatus, phase: TurnPhase, toolName?: string): TurnStatus {
  return { ...status, phase, toolName };
}

function applyTurnStart(status: TurnStatus, event: EventOf<"turn_start">): TurnStatus {
  const started: TurnStatus = {
    running: true,
    startedAt: event.at,
    phase: THINKING,
    inputTokens: 0,
    outputTokens: 0,
  };
  return status.contextTokens === undefined ? started : { ...started, contextTokens: status.contextTokens };
}

function applyUsage(status: TurnStatus, event: EventOf<"usage">): TurnStatus {
  return {
    ...status,
    inputTokens: status.inputTokens + event.inputTokens,
    outputTokens: status.outputTokens + event.outputTokens,
    contextTokens: event.inputTokens + (event.cacheRead ?? 0) + (event.cacheWrite ?? 0),
  };
}

/**
 * Folds one session event into the turn status. An event whose `metadata.subagentTask`
 * is set is a nested call's, so it leaves the status alone — returning the input object.
 */
export function reduceTurnStatus(status: TurnStatus, event: SessionEvent): TurnStatus {
  if (isSubagentEvent(event)) return status;
  switch (event.type) {
    case "turn_start":
      return applyTurnStart(status, event);
    case "thinking_delta":
      return inPhase(status, THINKING);
    case "text_delta":
      return inPhase(status, WRITING);
    case "tool_call":
      return inPhase(status, TOOL, event.name);
    case "tool_result":
      return inPhase(status, THINKING);
    case "approval_requested":
      return event.answerable === false ? status : inPhase(status, APPROVAL);
    case "approval_resolved":
      return inPhase(status, THINKING);
    case "compaction":
      return inPhase(status, COMPACTING);
    case "stream_reset":
      return inPhase(status, RETRYING);
    case "usage":
      return applyUsage(status, event);
    case "turn_end":
      return { ...status, running: false };
    default:
      return status;
  }
}

/** A token count for display: `999`, `1.2k` (one decimal from a thousand up). */
export function formatTokens(n: number): string {
  const rounded = Math.round(n);
  if (rounded < TOKEN_UNIT) return `${rounded}`;
  return `${(rounded / TOKEN_UNIT).toFixed(TOKEN_DECIMALS)}${TOKEN_SUFFIX}`;
}

/** The model without its provider prefix, elided to 24 characters. */
export function shortModel(model: string): string {
  const short = model.slice(model.lastIndexOf(MODEL_PATH_SEPARATOR) + 1);
  return short.length > SHORT_MODEL_MAX ? `${short.slice(0, SHORT_MODEL_KEEP)}${ELLIPSIS}` : short;
}

/** The gesture the footer offers, in precedence order; only one is ever shown. */
export type FooterHint = "quit" | "clear" | "busy" | "expanded" | "idle";

const HINT_TEXT: Readonly<Record<FooterHint, string>> = {
  quit: "press ctrl-c again to quit",
  clear: "esc again to clear",
  busy: "esc to interrupt",
  expanded: "ctrl+o to collapse",
  idle: "shift+tab to cycle",
};

const SEPARATOR = " · ";
const SANDBOX_OFF = "sandbox off";
const SANDBOX_UNAVAILABLE = "sandbox unavailable";

/** A context meter reads as a warning past 70% and as danger past 90%. */
const CONTEXT_WARNING_ABOVE = 70;
const CONTEXT_DANGER_ABOVE = 90;
const PERCENT = 100;
const COST_DECIMALS = 2;
const COST_PREFIX = "$";

/**
 * Glyphs a model composes with when its API has no theme argument (the footer's
 * deliberately does not): the default Unicode set, taken from the theme SSOT rather than
 * spelled as literals, so a screen drawing the line with a resolved theme still owns the
 * glyph fallback.
 */
const GLYPHS = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs;

function modeSpan(state: ChatHostState): Span {
  const full = state.mode === "full";
  const label = full ? "full" : "guarded";
  return { text: `${full ? GLYPHS.modeFull : GLYPHS.modeGuarded} ${label}`, color: full ? "danger" : "muted" };
}

function hintSpan(hint: FooterHint): Span {
  return { text: HINT_TEXT[hint], color: hint === "quit" ? "warning" : "muted" };
}

/** A sandbox nobody can rely on is a warning; one that is off is only a muted fact. */
function sandboxSpan(sandbox: ChatHostState["sandbox"]): Span | undefined {
  if (sandbox?.kind === "available") return undefined;
  if (sandbox?.kind === "unavailable") {
    return { text: `${SEPARATOR}${SANDBOX_UNAVAILABLE}`, color: "warning" };
  }
  return { text: `${SEPARATOR}${SANDBOX_OFF}`, color: "muted" };
}

function leftLine(state: ChatHostState, hint: FooterHint): StyledLine {
  if (hint === "quit") return [hintSpan(hint)];
  const sandbox = sandboxSpan(state.sandbox);
  const spans: Span[] = [modeSpan(state), { text: SEPARATOR, color: "muted" }, hintSpan(hint)];
  return sandbox === undefined ? spans : [...spans, sandbox];
}

/** The rounded share of the model's window the turn has used, when both numbers are known. */
function contextPercent(state: ChatHostState, status: TurnStatus): number | undefined {
  const { contextWindow } = state;
  if (contextWindow === undefined || contextWindow <= 0 || status.contextTokens === undefined) return undefined;
  return Math.round((status.contextTokens / contextWindow) * PERCENT);
}

function percentColor(percent: number): ChatColorToken {
  if (percent > CONTEXT_DANGER_ABOVE) return "danger";
  return percent > CONTEXT_WARNING_ABOVE ? "warning" : "muted";
}

function contextSpan(state: ChatHostState, status: TurnStatus): Span | undefined {
  const percent = contextPercent(state, status);
  if (percent === undefined) return undefined;
  return { text: `${SEPARATOR}${percent}% ctx`, color: percentColor(percent) };
}

function costSpan(state: ChatHostState): Span {
  const cost = (state.meta.costUsd ?? 0).toFixed(COST_DECIMALS);
  return { text: `${SEPARATOR}${COST_PREFIX}${cost}`, color: "muted" };
}

function rightLine(state: ChatHostState, status: TurnStatus): StyledLine {
  // The model is the host's text, so it is sanitised before it is measured or drawn.
  const model: Span = { text: shortModel(sanitizeText(state.model)) };
  const context = contextSpan(state, status);
  return context === undefined ? [model, costSpan(state)] : [model, context, costSpan(state)];
}

/**
 * The one-line footer: what the screen is doing on the left, what it costs on the right.
 * The whole left side is the warning quit hint while that hint is showing, so mode and
 * sandbox never compete with a pending quit.
 */
export function footerModel(input: { state: ChatHostState; status: TurnStatus; hint: FooterHint }): {
  left: StyledLine;
  right: StyledLine;
} {
  return { left: leftLine(input.state, input.hint), right: rightLine(input.state, input.status) };
}
