/**
 * The footer's context span: tokens in use against the model's window. Split from
 * `chat-status.ts` (line cap); it takes only types from it, so no import cycle forms.
 */

import type { ChatHostState } from "@/chat";
import type { TurnStatus } from "./chat-status";
import type { Span } from "./styled-line";
import type { ChatColorToken } from "./theme";

const TOKEN_UNIT = 1000;
const TOKEN_DECIMALS = 1;
const TOKEN_SUFFIX = "k";
const MILLION = 1_000_000;
const WINDOW_MILLION_FROM = 999_500;
const WINDOW_DECIMALS = 100;
const WINDOW_MILLION_SUFFIX = "M";
const SEPARATOR = " · ";
/** A context meter reads as a warning past 70% and as danger past 90%. */
const CONTEXT_WARNING_ABOVE = 70;
const CONTEXT_DANGER_ABOVE = 90;
const PERCENT = 100;

/** A token count for display: `999`, `1.2k` (one decimal from a thousand up). */
export function formatTokens(n: number): string {
  const rounded = Math.round(n);
  if (rounded < TOKEN_UNIT) return `${rounded}`;
  return `${(rounded / TOKEN_UNIT).toFixed(TOKEN_DECIMALS)}${TOKEN_SUFFIX}`;
}

/** A context window for display: `800`, `200k`, `1M`, `1.05M`. */
export function formatWindow(n: number): string {
  if (n >= WINDOW_MILLION_FROM) {
    return `${Math.round((n / MILLION) * WINDOW_DECIMALS) / WINDOW_DECIMALS}${WINDOW_MILLION_SUFFIX}`;
  }
  if (n >= TOKEN_UNIT) return `${Math.round(n / TOKEN_UNIT)}${TOKEN_SUFFIX}`;
  return `${n}`;
}

/** The rounded share of the model's window the turn has used, when both numbers are known. */
export function contextPercent(state: ChatHostState, status: TurnStatus): number | undefined {
  const { contextWindow } = state;
  if (contextWindow === undefined || contextWindow <= 0 || status.contextTokens === undefined) return undefined;
  return Math.round((status.contextTokens / contextWindow) * PERCENT);
}

export function percentColor(percent: number): ChatColorToken {
  if (percent > CONTEXT_DANGER_ABOVE) return "danger";
  return percent > CONTEXT_WARNING_ABOVE ? "warning" : "muted";
}

/** Tokens against the window with its percentage; tokens alone when the window is unknown. */
export function contextSpan(state: ChatHostState, status: TurnStatus): Span | undefined {
  const tokens = status.contextTokens;
  if (tokens === undefined) return undefined;
  const percent = contextPercent(state, status);
  if (percent === undefined || state.contextWindow === undefined) {
    return { text: `${SEPARATOR}${formatTokens(tokens)} ctx`, color: "muted" };
  }
  const text = `${formatTokens(tokens)}/${formatWindow(state.contextWindow)} ctx (${percent}%)`;
  return { text: `${SEPARATOR}${text}`, color: percentColor(percent) };
}
