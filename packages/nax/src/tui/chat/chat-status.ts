/**
 * The chat turn status as data: what the turn is doing right now, how long it has run
 * and how many tokens it has spent. `reduceTurnStatus` folds a session event stream into
 * it; `shortModel` and `formatTokens` are the display helpers the footer and the working
 * line share (US-016). `footerModel` composes the screen's one-line footer from a host
 * state, that status and the hint the screen is offering (US-017). `workingLine` turns
 * the same status into the animated line the screen redraws every `WORKING_TICK_MS`, and
 * `headerLines` composes the three fixed rows above the transcript (US-018).
 *
 * Everything here is pure. A status the event does not change is returned as the same
 * object, so a component that compares by reference does no needless work.
 */
import { parseModelSpec, type SessionEvent } from "@nathapp/nax-agent";
import { type ChatHostState, sessionTitleText } from "@/chat";
import { oneLine, resolveWidth } from "./layout-lines";
import { displayWidth, type Span, type StyledLine, sanitizeText } from "./styled-line";
import { type ChatColorToken, type ChatGlyphs, resolveChatTheme } from "./theme";
import { toolTitle } from "./tool-card";

/** What the turn is doing. Only meaningful while `running`. */
export type TurnPhase = "thinking" | "writing" | "tool" | "approval" | "compacting" | "retrying";

export interface TurnStatus {
  readonly running: boolean;
  readonly startedAt?: string;
  readonly phase: TurnPhase;
  readonly toolName?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly streamedChars: number;
  /** input + cacheRead + cacheWrite of the latest usage event; survives turn_end. */
  readonly contextTokens?: number;
}

/** No turn has run. `phase` is only read while `running`, so its value here is inert. */
export const IDLE_STATUS: TurnStatus = {
  running: false,
  phase: "thinking",
  inputTokens: 0,
  outputTokens: 0,
  streamedChars: 0,
};

const THINKING: TurnPhase = "thinking";
const WRITING: TurnPhase = "writing";
const TOOL: TurnPhase = "tool";
const APPROVAL: TurnPhase = "approval";
const COMPACTING: TurnPhase = "compacting";
const RETRYING: TurnPhase = "retrying";

const TOKEN_UNIT = 1000;
const TOKEN_DECIMALS = 1;
const CHARS_PER_ESTIMATED_TOKEN = 4;
const TOKEN_SUFFIX = "k";

/** Footer columns reserved for the model name alone, excluding its effort suffix. */
const SHORT_MODEL_MAX = 24;
const ELLIPSIS = "…";
/** The separator in a model's provider-qualified name and in a path. */
const PATH_SEPARATOR = "/";

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
    streamedChars: 0,
  };
  return status.contextTokens === undefined ? started : { ...started, contextTokens: status.contextTokens };
}

function applyUsage(status: TurnStatus, event: EventOf<"usage">): TurnStatus {
  return {
    ...status,
    inputTokens: status.inputTokens + event.inputTokens,
    outputTokens: status.outputTokens + event.outputTokens,
    streamedChars: 0,
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
      return { ...inPhase(status, THINKING), streamedChars: status.streamedChars + event.text.length };
    case "text_delta":
      return { ...inPhase(status, WRITING), streamedChars: status.streamedChars + event.text.length };
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
      return { ...inPhase(status, RETRYING), streamedChars: 0 };
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

/** Display parts retain even unknown effort levels without treating their text as a path. */
function modelParts(raw: string): { name: string; suffix: string } {
  const { model, effort } = parseModelSpec(raw);
  return {
    name: model.slice(model.lastIndexOf(PATH_SEPARATOR) + 1),
    suffix: effort === undefined ? "" : `[${effort}]`,
  };
}

/** The model without its provider prefix: at most 24 name columns, plus the whole suffix. */
export function shortModel(model: string): string {
  const { name, suffix } = modelParts(model);
  return `${elideEnd(name, SHORT_MODEL_MAX, ELLIPSIS)}${suffix}`;
}

/** The gesture the footer offers, in precedence order; only one is ever shown. */
export type FooterHint = "quit" | "clear" | "busy" | "expanded" | "idle" | "copied";

const HINT_TEXT: Readonly<Record<FooterHint, string>> = {
  copied: "copied",
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
 * Glyphs a model composes with when its caller passes none: the default Unicode set, taken
 * from the theme SSOT rather than spelled as literals. A screen that draws the line with a
 * resolved theme passes that theme's glyphs in, so an ASCII or a differently-glyphed terminal
 * reaches the header and the footer too — `StyledLineView` substitutes colours, not glyphs.
 */
const GLYPHS = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs;

/**
 * Host text as one row: escape sequences and controls are stripped, then a line break
 * becomes a space. The footer, a header line and the working line are one physical row
 * each, so a cwd, a version, a model or a tool name carrying a newline must not add a row
 * to the screen.
 */
function singleRow(text: string): string {
  return oneLine(sanitizeText(text));
}

/** The mode's label without its glyph: the footer draws it, the header states it. */
function modeLabel(mode: ChatHostState["mode"]): string {
  return mode === "full" ? "full" : "guarded";
}

function modeSpan(state: ChatHostState, glyphs: ChatGlyphs): Span {
  const full = state.mode === "full";
  return {
    text: `${full ? glyphs.modeFull : glyphs.modeGuarded} ${modeLabel(state.mode)}`,
    color: full ? "danger" : "muted",
  };
}

function hintSpan(hint: FooterHint, copiedChars = 0): Span {
  return {
    text: hint === "copied" ? `copied ${copiedChars} chars` : HINT_TEXT[hint],
    color: hint === "quit" ? "warning" : "muted",
  };
}

/** A sandbox nobody can rely on is a warning; one that is off is only a muted fact. */
function sandboxSpan(sandbox: ChatHostState["sandbox"]): Span | undefined {
  if (sandbox?.kind === "available") return undefined;
  if (sandbox?.kind === "unavailable") {
    return { text: `${SEPARATOR}${SANDBOX_UNAVAILABLE}`, color: "warning" };
  }
  return { text: `${SEPARATOR}${SANDBOX_OFF}`, color: "muted" };
}

function leftLine(input: {
  state: ChatHostState;
  hint: FooterHint;
  glyphs: ChatGlyphs;
  copiedChars?: number;
}): StyledLine {
  const { state, hint, glyphs, copiedChars } = input;
  if (hint === "quit") return [hintSpan(hint)];
  const sandbox = sandboxSpan(state.sandbox);
  const spans: Span[] = [modeSpan(state, glyphs), { text: SEPARATOR, color: "muted" }, hintSpan(hint, copiedChars)];
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

export interface FooterJob {
  readonly kind: "run" | "plan" | "bot_review" | "bot_fix";
  readonly target: string;
  readonly progress?: { readonly passed: number; readonly total: number };
  readonly cost?: number;
}

const JOB_TARGET_LIMIT = 16;
const JOB_STRIP_LIMIT = 2;

function jobPart(job: FooterJob): string {
  const target = singleRow(job.target);
  if (job.kind === "bot_review" || job.kind === "bot_fix") return `${job.kind} #${target}`;
  const feature = target.length > JOB_TARGET_LIMIT ? `${target.slice(0, JOB_TARGET_LIMIT - 1)}…` : target;
  let part = `${job.kind} ${feature}`;
  if (job.kind === "run") {
    if (job.progress !== undefined) part += ` ${job.progress.passed}/${job.progress.total}`;
    if (job.cost !== undefined) part += ` $${job.cost.toFixed(COST_DECIMALS)}`;
  }
  return part;
}

/** Compact, independent job ledger for the one-row footer. */
export function formatJobStrip(jobs: readonly FooterJob[]): string {
  const strip = jobs.slice(0, JOB_STRIP_LIMIT).map(jobPart).join(SEPARATOR);
  return jobs.length > JOB_STRIP_LIMIT ? `${strip} +${jobs.length - JOB_STRIP_LIMIT}` : strip;
}

function rightLine(state: ChatHostState, status: TurnStatus): StyledLine {
  // The model is the host's text, so it is reduced to the footer's one row before it is measured or drawn.
  const model: Span = { text: shortModel(singleRow(state.model)) };
  const context = contextSpan(state, status);
  return context === undefined ? [model, costSpan(state)] : [model, context, costSpan(state)];
}

/**
 * The one-line footer: what the screen is doing on the left, what it costs on the right.
 * The whole left side is the warning quit hint while that hint is showing, so mode and
 * sandbox never compete with a pending quit. `glyphs` defaults to the Unicode set so a caller
 * that has no theme still composes; a screen passes its resolved theme's.
 */
export function footerModel(input: {
  state: ChatHostState;
  status: TurnStatus;
  hint: FooterHint;
  copiedChars?: number;
  glyphs?: ChatGlyphs;
  jobs?: readonly FooterJob[];
}): {
  left: StyledLine;
  right: StyledLine;
} {
  return {
    left: leftLine({ ...input, glyphs: input.glyphs ?? GLYPHS }),
    right: [
      ...(input.jobs?.length
        ? [{ text: formatJobStrip(input.jobs) }, { text: SEPARATOR, color: "muted" as const }]
        : []),
      ...rightLine(input.state, input.status),
    ],
  };
}

/** How often the screen redraws the working line while a turn runs. */
export const WORKING_TICK_MS = 250;

/** Milliseconds one spinner frame stands for. */
const SPINNER_FRAME_MS = 120;
const MILLIS_PER_SECOND = 1000;
/** What the working line marks the turn's input and output tokens with. */
const UP_ARROW = "↑";
const DOWN_ARROW = "↓";

/**
 * The turn's elapsed milliseconds: `nowMs` past `startedAt`. A start that does not parse
 * (fixtures use `"now"`) or is missing counts as none, and a `nowMs` before the start
 * (a clock that moved back) counts as none rather than as negative time.
 */
function elapsedMs(status: TurnStatus, nowMs: number): number {
  if (status.startedAt === undefined) return 0;
  const start = Date.parse(status.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, nowMs - start);
}

/** The spinner frame showing at `elapsed`: one frame per `SPINNER_FRAME_MS`, wrapping. */
function spinnerFrame(elapsed: number, glyphs: ChatGlyphs): string {
  const frames = glyphs.spinner;
  if (frames.length === 0) return "";
  return frames[Math.floor(elapsed / SPINNER_FRAME_MS) % frames.length] ?? "";
}

/**
 * What the turn is doing, as a verb with the theme's ellipsis. A tool phase names the tool
 * by its card title, so `nax-agents__run` reads as `Agent`; a tool phase with no name can
 * only say that it is running something.
 */
function workingVerb(status: TurnStatus, glyphs: ChatGlyphs): string {
  const trailing = glyphs.ellipsis;
  switch (status.phase) {
    case "thinking":
      return `Thinking${trailing}`;
    case "writing":
      return `Writing${trailing}`;
    case "tool": {
      const title = status.toolName === undefined ? "" : toolTitle(singleRow(status.toolName));
      return title === "" ? `Running${trailing}` : `Running ${title}${trailing}`;
    }
    case "approval":
      return `Waiting for approval${trailing}`;
    case "compacting":
      return `Compacting${trailing}`;
    case "retrying":
      return `Retrying${trailing}`;
  }
}

/** The muted measurement behind the verb: the seconds, the tokens and the way out. */
function workingTokens(status: TurnStatus): string {
  const estimate = formatTokens(Math.ceil(status.streamedChars / CHARS_PER_ESTIMATED_TOKEN));
  if (status.inputTokens + status.outputTokens === 0) return `${DOWN_ARROW} ~${estimate} tokens`;
  const suffix = status.streamedChars > 0 ? ` (+~${estimate})` : "";
  return `${UP_ARROW} ${formatTokens(status.inputTokens)} ${DOWN_ARROW} ${formatTokens(status.outputTokens)}${suffix} tokens`;
}

function workingDetail(status: TurnStatus, elapsed: number): string {
  const seconds = Math.floor(elapsed / MILLIS_PER_SECOND);
  return ` (${seconds}s${SEPARATOR}${workingTokens(status)}${SEPARATOR}${HINT_TEXT.busy})`;
}

/**
 * The line the screen shows while a turn runs: a spinner frame and what the turn is doing,
 * in the accent colour, then a muted measurement of the time and the tokens. Undefined
 * when no turn runs, so the screen reserves no row for it.
 */
export function workingLine(status: TurnStatus, nowMs: number, glyphs: ChatGlyphs): StyledLine | undefined {
  if (!status.running) return undefined;
  const elapsed = elapsedMs(status, nowMs);
  const frame = spinnerFrame(elapsed, glyphs);
  return [
    // A glyph set with no frames says nothing rather than leaving a stray column.
    ...(frame === "" ? [] : [{ text: `${frame} `, color: "accent" as const }]),
    { text: workingVerb(status, glyphs), color: "accent" },
    { text: workingDetail(status, elapsed), color: "muted" },
  ];
}

const HEADER_TITLE = "nax chat";
/** Columns the sandbox suffix and its separator may need of the header's width. */
const HEADER_CWD_RESERVE = 20;
const HEADER_INDENT = "  ";
const HOME = "~";
const SANDBOX_ON = "sandbox on";

/** How a sandbox reads in the header: `available` is on, `unavailable` says so, else off. */
function headerSandbox(sandbox: ChatHostState["sandbox"]): string {
  if (sandbox?.kind === "available") return SANDBOX_ON;
  return sandbox?.kind === "unavailable" ? SANDBOX_UNAVAILABLE : SANDBOX_OFF;
}

/** A path with the user's home replaced by `~`; a path outside the home is left as it is. */
function withHome(path: string, home: string): string {
  const base = home.endsWith(PATH_SEPARATOR) ? home.slice(0, -PATH_SEPARATOR.length) : home;
  if (base === "") return path;
  if (path === base) return HOME;
  return path.startsWith(`${base}${PATH_SEPARATOR}`) ? `${HOME}${path.slice(base.length)}` : path;
}

/** The longest prefix of `text` that fits `columns` display columns. */
function headColumns(text: string, columns: number): string {
  let taken = "";
  let used = 0;
  for (const point of text) {
    const width = displayWidth(point);
    if (used + width > columns) break;
    taken += point;
    used += width;
  }
  return taken;
}

/** The longest suffix of `text` that fits `columns` display columns. */
function tailColumns(text: string, columns: number): string {
  let taken = "";
  let used = 0;
  for (const point of Array.from(text).reverse()) {
    const width = displayWidth(point);
    if (used + width > columns) break;
    taken = point + taken;
    used += width;
  }
  return taken;
}

/**
 * A text elided in the middle to at most `columns` display columns: the start and the end
 * are kept and the gap between them becomes the ellipsis, so a deep path still shows where
 * it begins and what it ends in. A negative or empty budget keeps the ellipsis alone.
 */
function elideMiddle(text: string, columns: number, ellipsis: string): string {
  const limit = Math.max(1, columns);
  if (displayWidth(text) <= limit) return text;
  const room = limit - displayWidth(ellipsis);
  if (room < 1) return headColumns(ellipsis, limit);
  const head = headColumns(text, Math.ceil(room / 2));
  return `${head}${ellipsis}${tailColumns(text, room - displayWidth(head))}`;
}

/** End-elision keeps the beginning of a title within its display-column budget. */
function elideEnd(text: string, columns: number, ellipsis: string): string {
  if (displayWidth(text) <= columns) return text;
  const room = columns - displayWidth(ellipsis);
  return room < 0 ? headColumns(ellipsis, columns) : `${headColumns(text, room)}${ellipsis}`;
}

const MIN_TITLE_COLUMNS = 8;

/** Elide only the name; even an exhausted budget keeps the whole ellipsis and suffix. */
function headerModel(raw: string, columns: number, ellipsis: string): string {
  const { name, suffix } = modelParts(raw);
  if (displayWidth(`${name}${suffix}`) <= columns) return `${name}${suffix}`;
  const room = Math.max(0, columns - displayWidth(suffix) - displayWidth(ellipsis));
  return `${headColumns(name, room)}${ellipsis}${suffix}`;
}

/** The session title yields first, then the model name; product, version and mode stay fixed. */
function headerTitleLine(state: ChatHostState, version: string, width: number, glyphs: ChatGlyphs): StyledLine {
  const title: Span = { text: `${glyphs.thinking} ${HEADER_TITLE}`, color: "accent", bold: true };
  const beforeModel = ` v${singleRow(version)}${SEPARATOR}`;
  const afterModel = `${SEPARATOR}${modeLabel(state.mode)}`;
  const modelRoom = width - displayWidth(`${title.text}${beforeModel}${afterModel}`);
  const model = headerModel(singleRow(state.model), modelRoom, glyphs.ellipsis);
  const facts = `${beforeModel}${model}${afterModel}`;
  const room = width - displayWidth(`${title.text}${facts}${SEPARATOR}`);
  const sessionTitle =
    state.meta.title !== null && room >= MIN_TITLE_COLUMNS
      ? `${SEPARATOR}${elideEnd(singleRow(sessionTitleText(state.meta.title, state.sessionId)), room, glyphs.ellipsis)}`
      : "";
  return [title, { text: `${facts}${sessionTitle}`, color: "muted" }];
}

/** The header's second line: where the session runs, and what it runs in. */
function headerPathLine(
  state: ChatHostState,
  cwd: string,
  home: string,
  width: number,
  glyphs: ChatGlyphs,
): StyledLine {
  const budget = Math.max(1, width - HEADER_CWD_RESERVE);
  const path = withHome(singleRow(cwd), singleRow(home));
  const shown = elideMiddle(path, budget, glyphs.ellipsis);
  return [
    { text: `${HEADER_INDENT}${shown}` },
    { text: `${SEPARATOR}${headerSandbox(state.sandbox)}`, color: "muted" },
  ];
}

/** The header's third line: a rule the full width of the terminal, closing the header off. */
function headerRuleLine(width: number, glyphs: ChatGlyphs): StyledLine {
  return [{ text: glyphs.rule.repeat(width), color: "border" }];
}

/**
 * The screen's fixed header: the product and the session's model and mode, where it runs,
 * and a rule the width of the terminal. `width` below `MIN_LAYOUT_WIDTH` is treated as
 * that minimum, and the path is elided in the middle to leave the sandbox suffix room.
 * `glyphs` is the drawing theme's set; it defaults to the Unicode one so a caller without a
 * theme still composes a complete header.
 */
export function headerLines(input: {
  state: ChatHostState;
  version: string;
  cwd: string;
  home: string;
  width: number;
  glyphs?: ChatGlyphs;
}): readonly StyledLine[] {
  const width = resolveWidth(input.width);
  const glyphs = input.glyphs ?? GLYPHS;
  return [
    headerTitleLine(input.state, input.version, width, glyphs),
    headerPathLine(input.state, input.cwd, input.home, width, glyphs),
    headerRuleLine(width, glyphs),
  ];
}
