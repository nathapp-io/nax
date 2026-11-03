/**
 * Full-screen chat composition: header, transcript viewport, live working line, bottom
 * region and one-row footer. Pure region models own drawing; this screen owns transcript,
 * turn status, persistent drafts and the row budget between them.
 *
 * Keys have one owner: ask card, picker and visible slash menu precede the input and
 * viewport. The screen owns ctrl+o and running-turn escape; useChatKeys owns ctrl-c and
 * shift+tab. Navigation ownership is checked at key time so batched completion and submit
 * cannot yield a key to a surface that is no longer mounted.
 * Same-session model and mode notices share one drawn-state comparison after control refresh.
 */

import type { CompactResult, ImageAttachment, SessionEvent, SteerResult, TurnEndStatus } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box, useInput, useStdout } from "ink";
import { type ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ChatHost, type ChatPendingAsk, createMentionFileIndex, expandChatMentions } from "@/chat";
import { buildCommandMessage } from "@/prompts";
import { runCommandShellLines } from "@/resources";
import { NAX_VERSION } from "@/version";
import { AskCard, askCardLayout } from "./AskCard";
import { askCardModel } from "./ask-card";
import { bottomBlocked, bottomRowsFor, menuRowsFor, viewportActive } from "./bottom-region";
import { ChatInput, type ChatInputHandle, EMPTY_DRAFT, INPUT_RULE_ROWS, type InputDraft, inputRows } from "./ChatInput";
import {
  footerModel,
  formatTokens,
  headerLines,
  IDLE_STATUS,
  isSubagentEvent,
  reduceTurnStatus,
  type TurnStatus,
  WORKING_TICK_MS,
  workingLine,
} from "./chat-status";
import { type EscAsk, type EscLayer, escHintText, topEscLayer } from "./esc-layer";
import { FixedRow } from "./FixedRow";
import {
  EMPTY_IMAGE_DRAFT,
  type ImageDraft,
  imagesForSend,
  splitLeadingPlaceholders,
  titleWithoutPlaceholders,
} from "./image-draft";
import { prepareImageSend } from "./image-send";
import { layoutTranscript } from "./layout";
import { type EditorState, EMPTY_EDITOR } from "./line-editor";
import { MentionMenu } from "./MentionMenu";
import { needsMentionExpansion, sentEntries } from "./mention-send";
import {
  type DiscardedSteers,
  type MessageQueue,
  pushDiscardedSteer,
  pushQueued,
  queueRowLines,
  queueToPrompt,
  type SteeringRow,
  steeringRowLines,
  takeQueued,
} from "./message-queue";
import type { MouseEvents } from "./mouse-input";
import { Picker, useChatPicker } from "./Picker";
import { SlashMenu } from "./SlashMenu";
import { sessionTranscript } from "./session-transcript";
import {
  LISTING_TITLES,
  parseSlashCommand,
  runSlashCommand,
  type SlashCommand,
  type SlashOutcome,
} from "./slash-commands";
import { slashMenuItemsForModel, slashMenuQueryState } from "./slash-menu";
import { slashSink } from "./slash-sink";
import { StyledLineView } from "./styled-line";
import { TranscriptViewport } from "./TranscriptViewport";
import { type ChatTheme, resolveChatTheme } from "./theme";
import { toggleTranscriptLine } from "./transcript-click";
import { reduceTranscript, type TranscriptEntry } from "./transcript-model";
import { turnStatsEntry } from "./turn-stats";
import { footerHint, useClipboardFeedback } from "./use-clipboard-feedback";
import { useImageAttach } from "./use-image-attach";
import { useJobs } from "./use-jobs";
import { FRAME_SLACK_ROWS, useJobsOpener } from "./use-jobs-opener";
import { useMentionMenu } from "./use-mention-menu";
import { useSlashMenuKeys } from "./use-slash-menu-keys";
import { useSwitchNotices } from "./use-switch-notices";
import { useChatKeys } from "./useChatKeys";

export interface ChatAppProps {
  readonly host: ChatHost;
  readonly mouse?: MouseEvents;
  /** Absent: colour off, Unicode glyphs — what a captured environment would resolve. */
  readonly theme?: ChatTheme;
  /** Absent: the running build's version. */
  readonly version?: string;
  /** Absent: the repository root the host reports. */
  readonly cwd?: string;
  /** Absent: no home prefix to shorten the header's path with. */
  readonly home?: string;
  /**
   * Told when the screen starts and stops working, so the terminal title can carry a busy
   * marker (US-008). Absent on a terminal with no title to keep current.
   */
  readonly onBusyChange?: (busy: boolean) => void;
}

/** Environment seam; sampled once per mounted screen. */
export const _chatAppDeps = {
  tmux: (): string | undefined => Bun.env.TMUX,
  /** Attach a typed message's mentions to it once, here in the TUI, before any brain sees it. */
  expandMentions: expandChatMentions,
  /** The `@` picker's file list; the screen builds exactly one per mount, for its own cwd. */
  mentionFileIndex: createMentionFileIndex,
};

const HEADER_ROWS = 3;
/** Rows the footer always claims. */
const FOOTER_ROWS = 1;
/** Rows the working line claims while a turn runs. */
const WORKING_ROWS = 1;
/** The viewport never shrinks below this, however little room the fixed regions leave. */
const MIN_VIEWPORT_ROWS = 1;
/** What a stream that cannot report its size is assumed to be. */
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
/** Every timer in the screen is cleared on unmount, so the tick is a chain, not an interval. */
const SANDBOX_WARNING = "sandbox unavailable: commands run outside the sandbox";
const TURN_BUSY_NOTICE = "wait for the turn to finish (Ctrl-C to interrupt)";
const QUIT = "quit";
/** What a host that cannot compact is told, and what a compaction with nothing to drop reports. */
const COMPACTION_UNAVAILABLE = "compaction is not available in this session";
const NOTHING_TO_COMPACT = "nothing to compact";
/** What `/compact` says while it runs, before the theme's ellipsis. */
const COMPACTING = "compacting";
const COMPACTED = "compacted";
/** The separator a compaction's before/after counts are joined with. */
const COMPACT_ARROW = "→";
/** What a busy return carrying a picture is told: a picture travels with a plain send only. */
const IMAGES_NOT_QUEUED = "images cannot be queued; send it after the turn ends";
/** What a slash line with a picture attached is told: an image travels with a plain message only. */
const IMAGES_PLAIN_ONLY = "images can only be sent with a plain message";
/**
 * What the transcript says about a refused line that could not go back into the prompt: the
 * user edited it while the send was being prepared, so the newer draft stays and the refused
 * line is named here rather than silently overwritten (see `imagePrepare`).
 */
const LINE_NOT_SENT = "not sent: ";
/** What the input offers after a declined ask, until the next submit says what to do instead. */
const TELL_NAX_HINT = "tell nax what to do instead";
/** ink reports ctrl+o as the letter `o` with the ctrl modifier, so the key is its `input`. */
const CTRL_O = "o";
/** And ctrl+v as `v` with the ctrl modifier: the clipboard image's key. */
const CTRL_V = "v";
/** And ctrl+s as `s`: the key that steers the running turn, or interrupts it and sends next. */
const CTRL_S = "s";
/** The theme a caller that passes none gets; resolved once, since it is a pure constant. */
const DEFAULT_THEME = resolveChatTheme({ env: {}, colorLevel: 0 });

/** A question card's draft and the request it was typed for: a new request starts empty. */
interface QuestionAnswer {
  readonly requestId: string;
  readonly draft: InputDraft;
}

/** No question answered yet — the state a fresh screen opens on. */
const NO_ANSWER: QuestionAnswer = { requestId: "", draft: EMPTY_DRAFT };

/**
 * A message composed for `host.send`: the text the brain reads, the images that travel with it
 * — absent or empty when the message carries none — and the image draft the message was
 * submitted with, so the send empties exactly the pictures it took and leaves a draft the user
 * started while it was preparing (see `sendMessage`).
 */
interface ComposedSend {
  readonly message: string;
  readonly images?: readonly ImageAttachment[];
  readonly draft?: ImageDraft;
}

/**
 * What a send's prepare step resolves: the composed message to send, or the notice that says
 * why the line goes nowhere — carrying the line itself when the prompt moved on while the
 * preparation ran and the line could not go back into it (see `imagePrepare`).
 */
type PreparedSend = ComposedSend | { readonly notice: string; readonly dropped?: string };

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

/** No line is waiting for a turn: the queue a screen opens with, and the one it drains to. */
const EMPTY_QUEUE: MessageQueue = [];

/** No steer is waiting for the running turn: the list a screen opens with. */
const EMPTY_STEERING: readonly SteeringRow[] = [];

/** How a turn's send settled, for the queue: whether it reached the host at all. */
interface TurnOutcome {
  /** False when the send never happened — a prepare step refused it, or it rejected. */
  readonly sent: boolean;
  /** The status of the turn's own `turn_end`, or undefined when the stream ended without one. */
  readonly status: TurnEndStatus | undefined;
}

/** The stream's size, with the assumed defaults where it cannot report one. */
function terminalSize(stdout: { columns?: number; rows?: number }): TerminalSize {
  return { columns: stdout.columns || DEFAULT_COLUMNS, rows: stdout.rows || DEFAULT_ROWS };
}

/**
 * The status of a turn whose stream has settled. A `turn_end` already stopped it; a stream
 * that ended without one (a rejection, or a runner that threw) leaves the status running, and
 * carrying it forward would keep the working line and the busy footer alive for a turn that
 * no longer exists. The token and context totals are kept — they are what the footer reports.
 */
function stopTurn(status: TurnStatus): TurnStatus {
  return status.running ? { ...status, running: false } : status;
}

/**
 * The status a running compaction shows (US-005): the working line's own `compacting` phase,
 * with no turn behind it. The context total survives, so the footer's reading does not blink
 * out while the compaction runs; the result's `tokensAfter` replaces it when it settles.
 */
function compactingStatus(current: TurnStatus): TurnStatus {
  return {
    running: true,
    startedAt: new Date().toISOString(),
    phase: "compacting",
    inputTokens: 0,
    outputTokens: 0,
    streamedChars: 0,
    ...(current.contextTokens === undefined ? {} : { contextTokens: current.contextTokens }),
  };
}

/** What a finished compaction reports: how much history it replaced, and with how much. */
function compactedNotice(result: CompactResult): string {
  const before = formatTokens(result.tokensBefore);
  const after = formatTokens(result.tokensAfter);
  return `${COMPACTED}: ${before} ${COMPACT_ARROW} ${after} tokens`;
}

/** Notices wait until neither a turn, a bottom-region surface nor host control owns the screen. */
function idleForJobNotice(input: { turnRunning: boolean; bottomBlocked: boolean; canControl: boolean }): boolean {
  return !input.turnRunning && !input.bottomBlocked && input.canControl;
}

/**
 * The rows the queue draws above the input. An ask card or a picker replaces the input, and
 * the queue drawn above it with it: nothing is drawn then, so nothing is reserved either.
 */
function queueLinesFor(queue: MessageQueue, blocked: boolean): readonly string[] {
  return blocked ? EMPTY_QUEUE : queueRowLines(queue);
}

/**
 * The rows the steers the running turn has not taken yet draw above the queue (US-004). They
 * are reserved and drawn beside the queue's, and left out with it when an ask card or a picker
 * replaces the input and the rows above it.
 */
function steeringLinesFor(steering: readonly SteeringRow[], blocked: boolean): readonly string[] {
  return blocked ? EMPTY_QUEUE : steeringRowLines(steering);
}

/** An ask card, a picker, or any menu drawn under the input, claims the bottom region. */
function surfaceShown(cardOrPicker: boolean, ...menus: readonly boolean[]): boolean {
  return cardOrPicker || menus.includes(true);
}

/**
 * The card the screen is drawing, in the terms the esc layer answers in. A host choice is
 * mapped by its own arm: it carries no `sessionId`, and reading one off every ask would only
 * be a field the choice arm does not have.
 */
function escAsk(ask: ChatPendingAsk | undefined): EscAsk | undefined {
  if (ask === undefined) return undefined;
  if (ask.type === "question") return "question";
  return ask.type === "approval_requested" ? "approval" : "choice";
}

/**
 * Whether the chat session itself asked the question. A run ask or a job asks through the
 * same card with `sessionId` `"host"`, and closing that one must leave the chat turn running:
 * the question came from elsewhere, so nothing here is waiting for the answer.
 */
function askedBySession(ask: ChatPendingAsk | undefined): boolean {
  return ask !== undefined && ask.type === "question" && ask.sessionId !== "host";
}

export function ChatApp({
  host,
  mouse,
  theme = DEFAULT_THEME,
  version = NAX_VERSION,
  cwd = host.repoRoot,
  home = "",
  onBusyChange,
}: ChatAppProps): ReactElement {
  const { stdout } = useStdout();
  const [tmux] = useState(() => Boolean(_chatAppDeps.tmux()));
  const { copiedChars, onCopy } = useClipboardFeedback(mouse);
  const [size, setSize] = useState<TerminalSize>(() => terminalSize(stdout));
  const state = host.current();
  const transcriptSession = useRef(state.sessionId);
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>(() => sessionTranscript(host));
  const [status, setStatus] = useState<TurnStatus>(IDLE_STATUS);
  const [draft, setDraft] = useState<InputDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  /** The lines typed while a turn was running, drawn above the input until it finishes. */
  const [queued, setQueued] = useState<MessageQueue>(EMPTY_QUEUE);
  /** The steers the running turn has not taken yet, drawn above the queue (US-004). */
  const [steering, setSteering] = useState<readonly SteeringRow[]>(EMPTY_STEERING);
  const [clearArmed, setClearArmed] = useState(false);
  const [answerDraft, setAnswerDraft] = useState<QuestionAnswer>(NO_ANSWER);
  /** What an empty input offers instead of its placeholder: a declined ask's instruction. */
  const [hint, setHint] = useState<string | undefined>(undefined);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [expanded, setExpanded] = useState(false);
  /** The query an escape put the slash menu away at; suppression ends when the text changes. */
  const [dismissedQuery, setDismissedQuery] = useState<string | undefined>(undefined);
  /** Bumped on every send, so the viewport returns to the newest line the user just added. */
  const [followToken, setFollowToken] = useState(0);
  /** The input's handle: the draft ref and the clear-arm the menu's two actions share. */
  const inputHandle = useRef<ChatInputHandle | undefined>(undefined);
  /**
   * The newest editor state, ahead of React: an image read that lands after an `await` puts
   * its placeholder at the cursor as it stands then, not the one the keypress saw.
   */
  const editorRef = useRef<EditorState>(EMPTY_EDITOR);
  /**
   * How many times the prompt has changed. A send that can only be refused after an `await`
   * — the capability probe — reads it again when the answer lands: the same number means the
   * prompt is still the line it submitted, and a different one means the user has moved on.
   */
  const promptRevision = useRef(0);
  const sending = useRef(false);
  /**
   * The queue as it stands, ahead of React: the drain runs after a send's `await`s, and it
   * must read the lines queued in that window — the newest state, not the last render's.
   */
  const queueRef = useRef<MessageQueue>(EMPTY_QUEUE);
  /**
   * The steers the turn running now discarded, in the order they were steered (US-004). One
   * turn's pending steers settle together — `applied` resolving `false` one callback at a time,
   * in arrival order — so they are placed as one group rather than prepended one by one, which
   * would reverse them. The group is scoped to its own turn: every send starts it empty, so a
   * line a later turn discards goes ahead of the queue that turn inherited rather than joining
   * the group of the turn before it.
   */
  const discardedSteers = useRef<DiscardedSteers | undefined>(undefined);
  /**
   * The status of the turn's own `turn_end` in the send now running, reset by every send. A
   * nested call's `turn_end` is not the turn's (`isSubagentEvent`), and a send that settles
   * without one leaves it undefined: only a turn observed to have completed drains the queue.
   */
  const turnEnd = useRef<TurnEndStatus | undefined>(undefined);
  /**
   * The live events of the turn running now (US-007), which is what its decode speed is
   * measured from. Every send starts a new list, and a nested call's event never joins it:
   * a subagent's rounds are not this turn's, so they neither measure its speed nor end it.
   *
   * A mutable list, not a replaced one: it is a ref rather than state, so nothing renders from
   * it, and a long turn appends thousands of deltas — copying the list on every one of them
   * would cost more than the whole turn.
   */
  const turnEvents = useRef<SessionEvent[]>([]);
  /**
   * The line a ctrl+s interrupted the running turn for (US-004). A brain that cannot steer
   * takes the key as interrupt-and-send: the line waits here until that turn settles, then
   * goes first — ahead of anything queued, which stays queued behind it.
   */
  const interruptSend = useRef<string | undefined>(undefined);
  const [, refresh] = useState(0);

  const update = useCallback(() => refresh((revision) => revision + 1), []);
  /** Replace the queue, for this batch and for the next render — as `editorRef` does the draft. */
  const replaceQueue = useCallback((next: MessageQueue) => {
    queueRef.current = next;
    setQueued(next);
  }, []);
  const appendAll = useCallback((added: readonly TranscriptEntry[]) => {
    setEntries((rows) => [...rows, ...added]);
  }, []);
  const append = useCallback((entry: TranscriptEntry) => appendAll([entry]), [appendAll]);
  const showError = useCallback((error: unknown) => append({ kind: "error", text: errorMessage(error) }), [append]);
  const keys = useChatKeys({
    host,
    running: sending,
    refresh: update,
    onError: showError,
    onNotice: (text) => append({ kind: "notice", text }),
  });
  /** The picker a `picker` outcome opens (US-027): the list, and what its keys do. */
  const picker = useChatPicker({ host, runControl: keys.runControl, onError: showError, show: append });
  const ask = host.asks.pending()[0];
  /** A turn is in flight from the send until its stream settles — the footer's busy rule. */
  const turnRunning = busy || status.running;
  // The menu offers what the host's catalogue adds to the built-ins, except on an ACP brain, which
  // has its own commands. The catalogue is fixed for a session's life, so the items follow the
  // host and the current model rather than being rebuilt on every tick.
  const catalog = host.catalog;
  const menuItems = useMemo(() => slashMenuItemsForModel(catalog, state.model), [catalog, state.model]);
  // Read menu ownership at key time: batched tab/argument/return can precede React's redraw.
  const slashKeys = useSlashMenuKeys({
    items: menuItems,
    initialQuery: draft.editor.text,
    initialDismissal: dismissedQuery,
    blocked: bottomBlocked(ask, picker.model),
  });
  // Escape suppresses matching slash queries until the prompt changes; cards take precedence.
  const menu = slashMenuQueryState({
    items: menuItems,
    query: draft.editor.text,
    dismissed: dismissedQuery,
    blocked: bottomBlocked(ask, picker.model),
  });
  // Measure first: an invisible menu must not claim navigation or run unseen commands. The
  // working line's row is decided here, from the turn alone; its text is composed further
  // down, once the layer that names esc's action can be read without a cycle.
  const workingShown = status.running;
  const usableRows = size.rows - FRAME_SLACK_ROWS;
  /**
   * The rows the queue draws above the input, and the height it claims: like the working line,
   * it is reserved out of the usable rows before the bottom region's budget is measured, so a
   * queue never eats the prompt's own room. An ask card or a picker replaces the input, and
   * the queue with it — nothing is drawn then, so nothing is reserved either.
   */
  const queueLines = queueLinesFor(queued, bottomBlocked(ask, picker.model));
  const steeringLines = steeringLinesFor(steering, bottomBlocked(ask, picker.model));
  /** The steering rows then the queue's: everything the screen draws above the input. */
  const aboveInputLines = [...steeringLines, ...queueLines];
  const bottomBudget = Math.max(
    1,
    usableRows -
      HEADER_ROWS -
      (workingShown ? WORKING_ROWS : 0) -
      aboveInputLines.length -
      FOOTER_ROWS -
      MIN_VIEWPORT_ROWS,
  );
  const menuRows = menuRowsFor({ rows: menu.rows, budget: bottomBudget });
  /** A menu with no row budget cannot own keys. */
  function menuShown(): boolean {
    return menu.open && menuRows > 0;
  }
  /** Check visibility and the newest prompt, not the render preceding a batched key. */
  function menuOwnsKeys(): boolean {
    return menuShown() && slashKeys.ownsKeys();
  }
  // The `@` picker draws under the same input and takes the same keys; it builds one file list
  // for the cwd the screen was handed, and writes a chosen row through the input's handle.
  const mention = useMentionMenu({
    cwd,
    indexFor: _chatAppDeps.mentionFileIndex,
    editor: draft.editor,
    blocked: bottomBlocked(ask, picker.model),
    suppressed: menuShown(),
    slashOwns: menuOwnsKeys,
    budget: bottomBudget,
    active: !keys.locked,
    handle: inputHandle,
  });
  const mentionView = mention.view;
  /** True while the picker's rows (or its diagnostic line) are drawn under the input. */
  const mentionShown = mentionView.rows > 0;
  if (menu.reopen) {
    slashKeys.sawDismissal(undefined);
    setDismissedQuery(undefined);
  }
  /**
   * The layer esc acts on, read from what this frame draws — one answer for the footer, the
   * working line and the screen's own guard, so the hint and the action cannot disagree. A
   * turn whose keys cannot control it is not esc's to stop, and the mention picker's claim is
   * its esc ownership rather than its drawn rows: its no-git diagnostic line claims no key.
   *
   * `running` is the turn ownership the caller trusts. Everything drawn passes the frame's own
   * `turnRunning`; a key handler passes the synchronous `sending` ref, because a return, the
   * text typed after it and a chord can arrive in one batch, and the render that preceded that
   * batch still says the turn is idle. Only the turn's ownership is read that way — a card, a
   * picker and a menu still claim their keys from the frame, and the control guard is
   * unchanged — so a batched key cannot stop a turn nobody owns or steal an overlay's escape.
   */
  function escLayer(running: boolean): EscLayer {
    return topEscLayer({
      ask: escAsk(ask),
      askFromSession: askedBySession(ask),
      picker: picker.model?.kind,
      mentionShown: mention.ownsNavigation(),
      menuShown: menuShown(),
      turnRunning: running && keys.canControl(),
    });
  }
  const escHint = escHintText(escLayer(turnRunning));
  // The working line is drawn from the turn status alone, so its presence is unchanged; only
  // its text takes the layer's hint, and `esc to interrupt` stays when the layer has none.
  const working = workingLine(status, nowMs, theme.glyphs, escHint);
  // The image draft lives beside the prompt, not inside it: this hook reads the clipboard on
  // ctrl+v, takes a pasted image path and writes the placeholder back through the handle.
  const imageAttach = useImageAttach({
    cwd,
    input: inputHandle,
    editor: () => editorRef.current,
    notice: (text) => append({ kind: "notice", text }),
    active: () => !bottomBlocked(ask, picker.model),
  });

  // Ctrl+o toggles detail; ctrl+v attaches a clipboard image; ctrl+s steers the running turn
  // (or interrupts it and sends the draft next); escape interrupts only when no bottom surface
  // or control owns it. The hook decides whether a key is theirs to answer.
  useInput((input, key) => {
    if (key.ctrl && input === CTRL_O) {
      setExpanded((current) => !current);
      return;
    }
    if (key.ctrl && input === CTRL_V) {
      void imageAttach.attach();
      return;
    }
    if (key.ctrl && input === CTRL_S) {
      steerRunningTurn();
      return;
    }
    // Only a bare running turn is the screen's own escape. A card, a picker and a menu each
    // own escape themselves and answer it in their own handler, so a key they close must
    // never also reach the turn. The turn's ownership is read synchronously, like every other
    // key-time fact: the frame's answer is a render old when a batch carries several keys.
    if (!key.escape || escLayer(sending.current).kind !== "turn") return;
    host.cancel();
  });

  // A resized terminal re-draws at the new size; the listener is the screen's own, so a
  // stream that ink itself does not watch still re-measures.
  useEffect(() => {
    const onResize = (): void => setSize(terminalSize(stdout));
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  /**
   * The terminal title's busy marker (US-008): what the screen reports when it starts or stops
   * working. Only a *change* is reported — the title is rewritten from it, so an idle mount
   * says nothing (the caller has not taken the title yet) and a re-render says nothing either.
   * Nothing is reported after the screen unmounts, which is when the title is given back.
   */
  const reportedBusy = useRef(false);
  useEffect(() => {
    if (reportedBusy.current === turnRunning) return;
    reportedBusy.current = turnRunning;
    onBusyChange?.(turnRunning);
  }, [turnRunning, onBusyChange]);
  // Rebuild before notice effects append, but never reset mount notices or same-id live rows.
  useLayoutEffect(() => {
    if (transcriptSession.current === state.sessionId) return;
    transcriptSession.current = state.sessionId;
    setEntries(sessionTranscript(host));
  }, [host, state.sessionId]);
  useSwitchNotices(state, append);
  useEffect(() => host.asks.onChange(update), [host, update]);
  useEffect(() => {
    const resourceNotice = host.resourceNotice?.();
    if (resourceNotice) append({ kind: "notice", text: resourceNotice });
  }, [host, append]);

  const notice = host.notice();
  const warn = state.mode === "full" && state.sandbox?.kind === "unavailable";
  // biome-ignore lint/correctness/useExhaustiveDependencies: identical interruption text must reappear after each session rebuild.
  useEffect(() => {
    if (notice) append({ kind: "notice", text: notice });
  }, [notice, state.sessionId, append]);
  useEffect(() => {
    if (warn) append({ kind: "warning", text: SANDBOX_WARNING });
  }, [warn, append]);

  // The working line's clock: a `setTimeout` chain, cancelled when the turn ends and on
  // unmount. `setInterval` cannot be stopped by the cleanup before its next tick fires.
  useEffect(() => {
    if (!status.running) return;
    let handle: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const tick = (): void => {
      setNowMs(Date.now());
      if (live) handle = setTimeout(tick, WORKING_TICK_MS);
    };
    handle = setTimeout(tick, WORKING_TICK_MS);
    return () => {
      live = false;
      if (handle !== undefined) clearTimeout(handle);
    };
  }, [status.running]);

  /** Every session event lands in the transcript and in the turn status, and nothing else. */
  const handleEvent = useCallback(
    (event: SessionEvent) => {
      setEntries((rows) => reduceTranscript(rows, event));
      setStatus((current) => reduceTurnStatus(current, event));
      if (event.type === "turn_start") setNowMs(Date.now());
      // A nested call's events are its own: they measure nothing for this turn's statistics.
      if (!isSubagentEvent(event)) turnEvents.current.push(event);
      // The queue's own reading of the turn: what the top-level `turn_end` said, so a send that
      // settles without one — a rejection, a runner that threw — never looks completed.
      if (event.type === "turn_end" && !isSubagentEvent(event)) {
        turnEnd.current = event.status;
        // What the turn decoded, as one muted row under the reply it measured (US-007).
        const stats = turnStatsEntry(turnEvents.current, event);
        if (stats !== undefined) append(stats);
      }
    },
    [append],
  );

  /** A slash command's shown text, listed or noticed, and the session `clear` resets. */
  async function runCommand(command: SlashCommand): Promise<void> {
    const title = LISTING_TITLES.get(command.name);
    const sink = slashSink(title, append);
    let outcome: SlashOutcome | undefined;
    const ready = await keys.runControl(async () => {
      outcome = await runSlashCommand(command, { host, show: sink.show });
    });
    sink.flush();
    if (!ready) return;
    if (outcome === undefined) return;
    if (outcome.kind === "compact") {
      await compactTurn();
      return;
    }
    if (outcome.kind === "picker") {
      picker.open(outcome.picker);
      return;
    }
    // `/image` hands over the picture's name, or none for the clipboard: the attach hook reads
    // it, writes the placeholder and notices any refusal. Nothing is sent.
    if (outcome.kind === "attach") {
      await imageAttach.attach(outcome.path);
      return;
    }
    if (outcome.kind === "send") {
      noteUserTurn();
      await sendTurn({ message: outcome.message }, undefined, `/${command.name}${command.rest}`);
      return;
    }
    const { name, template, rest } = outcome;
    await sendTurn({ message: `/${name}${rest}` }, async () => {
      const expandedLines = await runCommandShellLines(template, (cmd) =>
        host.runCommand
          ? host.runCommand(cmd, () => update())
          : Promise.resolve({ isError: true, content: "this session cannot run commands" }),
      );
      if ("failed" in expandedLines) {
        const { command: failed, reason } = expandedLines.failed;
        return { notice: `command /${name} not sent: !\`${failed}\` failed: ${reason}` };
      }
      noteUserTurn();
      return { message: buildCommandMessage(expandedLines.text, rest) };
    });
  }

  /** Put a refused line back in the prompt, cursor at its end, so return sends it again. */
  function restorePrompt(text: string): void {
    inputHandle.current?.edit({ text, cursor: Array.from(text).length });
  }

  /**
   * A slash line with a picture still in the message runs nothing: an image travels with a
   * plain message only, so the line goes back into the prompt before any command effect — a
   * model switch or the quit included — and the draft keeps the picture.
   */
  function refuseSlashLine(message: string): void {
    append({ kind: "notice", text: IMAGES_PLAIN_ONLY });
    restorePrompt(message);
  }

  /**
   * The prepare step for a message that carries a placeholder image or a mention: the image-send
   * module decides what travels and asks the brain's capability once. The screen only restores a
   * refused line — the text and the draft — and hands a composed message on to `host.send`.
   *
   * `draft` is the draft the message was submitted with, not the draft as it stands when the
   * preparation settles: the prompt and ctrl+v stay live while the capability is asked, and an
   * image attached in that window belongs to the *next* message.
   *
   * A refusal puts the line back only while the prompt still holds it. `revision` is the prompt's
   * count when the line was submitted, so the user may have typed, deleted or attached a picture
   * for the next message by the time the answer lands; overwriting that draft would delete an
   * edit the refusal never saw. The newer prompt then stays, and the refused line travels with
   * the notice as `dropped` so it is named in the transcript instead of vanishing.
   *
   * `owns` is false for a queued line: it was typed for an earlier turn, and the prompt standing
   * now is the user's next message, whatever its revision count. A refusal never overwrites that
   * prompt — the refused line and whatever is still queued go back above it, oldest first, so the
   * user's own draft survives and the refused line is theirs to fix.
   */
  function imagePrepare(input: {
    readonly text: string;
    readonly draft: ImageDraft;
    readonly revision: number;
    readonly owns: boolean;
  }): () => Promise<PreparedSend> {
    const { text, draft, revision, owns } = input;
    return async () => {
      const result = await prepareImageSend({
        text,
        draft,
        where: { cwd, repoRoot: host.repoRoot },
        expand: _chatAppDeps.expandMentions,
        // Optional so a hand-built host still typechecks: one without it cannot read images.
        acceptsImages: () => host.acceptsImages?.() ?? Promise.resolve(false),
        model: host.current().model,
      });
      if (result.kind === "refuse") {
        if (!owns) {
          restoreRefused(text);
          return { notice: result.notice };
        }
        if (promptRevision.current === revision) {
          restorePrompt(text);
          return { notice: result.notice };
        }
        return { notice: result.notice, dropped: text };
      }
      return { message: result.message, images: result.images, ...(owns ? { draft } : {}) };
    };
  }

  /**
   * A queued line the prepare step refused: it goes back into the prompt above the draft
   * standing there, ahead of whatever is still queued behind it, and the queue empties — the
   * same restoration a turn that did not complete performs. The live draft is never overwritten:
   * it is the user's next message, not the refused line's.
   */
  function restoreRefused(text: string): void {
    const queue = queueRef.current;
    replaceQueue(EMPTY_QUEUE);
    restorePrompt(queueToPrompt([text, ...queue], editorRef.current.text));
  }

  /**
   * The slash line a submitted message runs, and the placeholders it runs after.
   *
   * After `/image red.png` the prompt holds `[Image #1]`, so `/image green.png` typed after it
   * would otherwise be part of a message and go to the model as text. A message that opens with
   * the placeholders of the pictures it holds and then a slash line runs that line: `lead` is
   * what goes back into the prompt — the placeholders, exactly as typed — and `line` is the
   * slash line, which is parsed as if the user had typed it alone. Any other message is its own
   * line, and `lead` is absent.
   */
  function submittedLine(message: string): { readonly line: string; readonly lead?: string } {
    const split = splitLeadingPlaceholders(message);
    return split === undefined ? { line: message } : { line: split.rest, lead: split.lead };
  }

  /**
   * A non-slash message's send: the plain two-argument call, or the one prepared for the images
   * and mentions the line carries. `ownsDraft` is false for a queued line, which takes none of
   * the prompt's pictures (`submitted` is empty) and hands no draft over, so nothing the user
   * attached since is emptied.
   */
  async function sendLine(input: {
    readonly message: string;
    readonly line: string;
    readonly submitted: ImageDraft;
    readonly ownsDraft: boolean;
  }): Promise<void> {
    const { message, line, submitted, ownsDraft } = input;
    const composed: ComposedSend = ownsDraft ? { message, draft: submitted } : { message };
    noteUserTurn();
    if (imagesForSend(submitted, line).images.length === 0 && !needsMentionExpansion(message)) {
      await sendTurn(composed);
      return;
    }
    // The prompt's count as the line leaves it, so a refusal that lands later can tell whether
    // the user has redrawn the prompt since (see `imagePrepare`).
    const prepare = imagePrepare({
      text: message,
      draft: submitted,
      revision: promptRevision.current,
      owns: ownsDraft,
    });
    await sendTurn(composed, prepare);
  }

  /**
   * A non-slash message's send. One that carries a placeholder image or a mention is prepared —
   * expanded once against the cwd the screen was handed and the repo the host reports, with the
   * images its placeholders still name — while a plain one keeps today's exact call; either way
   * the typed text stays the title and the draft history. The draft is read once here, so what
   * the send consumed is what the reset takes back however long the preparation takes.
   *
   * `ownsDraft` is false for a line that came off the queue. That line was typed for an earlier
   * turn, so the pictures in the prompt now belong to the user's next message: a queued send
   * takes none of them and — because it hands over no draft — empties none of them either.
   */
  async function submit(message: string, ownsDraft = true): Promise<void> {
    // A slash line after the leading placeholders is the line that runs; the images it is
    // refused for are the ones *it* names, not the ones it left in the prompt.
    const { line, lead } = submittedLine(message);
    const command = parseSlashCommand(line);
    // A queued line owns none of the prompt's pictures: they are the next message's.
    const submitted = ownsDraft ? imageAttach.current() : EMPTY_IMAGE_DRAFT;
    const images = imagesForSend(submitted, line).images;
    if (!command) {
      await sendLine({ message, line, submitted, ownsDraft });
      return;
    }
    // The image refusal comes before every command effect, `quit` included: a slash line never
    // closes the chat while the draft still holds a picture the send never took. It reads the
    // placeholders of `line`, so a command that left them in the prompt is not refused for them.
    if (images.length > 0) {
      refuseSlashLine(message);
      return;
    }
    // The placeholders between the prompt and the command go back into it before the command
    // runs, picture draft and all — `/image` then attaches beside them, and a plain next message
    // still carries them.
    if (lead !== undefined) restorePrompt(lead);
    if (command.name === QUIT) {
      if (sending.current) host.cancel();
      await keys.close();
      return;
    }
    if (sending.current) {
      append({ kind: "notice", text: TURN_BUSY_NOTICE });
      return;
    }
    await runCommand(command);
  }

  /**
   * A plain return while a turn runs, taken by the input before it drops the line. The text is
   * held for the next turn, and `true` tells the input to empty the prompt — the line is the
   * queue's now, so leaving it in the prompt would send it twice.
   *
   * A line whose draft still holds the picture it names is refused instead: an image travels
   * with a plain send that the screen prepares, and a queued line is submitted later, from a
   * prompt and a draft that may have moved on. The user is told to send it when the turn ends,
   * and the draft — the picture and the text — stays exactly as it was.
   */
  function queueReturn(text: string): boolean {
    if (imagesForSend(imageAttach.current(), text).images.length > 0) {
      append({ kind: "notice", text: IMAGES_NOT_QUEUED });
      return false;
    }
    replaceQueue(pushQueued(queueRef.current, text));
    return true;
  }

  /**
   * What ctrl+s would steer with, or undefined when the key does nothing at all: an empty
   * prompt and a slash line are return's business — a command is never steered into a turn —
   * and a whitespace-only draft is no message.
   */
  function steerText(): string | undefined {
    const text = editorRef.current.text;
    if (text.trim() === "") return undefined;
    return parseSlashCommand(text) === null ? text : undefined;
  }

  /**
   * ctrl+s (US-004): hand the typed line to the turn that is running, or — with nothing
   * running — send it exactly as a return would.
   *
   * Which of the two it is comes from `sending`, never from the rendered `busy` flag: a return,
   * the text typed after it and this chord can arrive in one batch, and the flag of the render
   * that preceded that batch still says idle while `sendTurn` has already taken the turn. The
   * draft is cleared only once something has taken the line — a steer, the pending interrupt
   * send, the queue, or the input's own submit — so a batched line is never emptied and dropped.
   *
   * A brain that steers takes the line where the turn is, and the prompt empties at once: the
   * steering row above the queue says what the turn has not applied yet, and settles the way
   * the turn did. A brain that cannot (`unsupported`, `no_turn`, or no `steer` at all) is
   * interrupted the way escape interrupts it, with the line held to be sent first once that
   * turn settles — see `drainQueue` — or queued behind that pending send when one is already
   * waiting. A picture in the draft is refused with the queue's own notice, and a steer that
   * rejects leaves the draft exactly as it was: the line never reached the turn, so it is still
   * the user's to edit or send.
   */
  function steerRunningTurn(): void {
    const text = steerText();
    if (text === undefined) return;
    if (!sending.current) {
      // No send of the screen's is in flight: the same path a return takes, prompt emptied and
      // history kept.
      inputHandle.current?.submit(text);
      return;
    }
    if (imagesForSend(imageAttach.current(), text).images.length > 0) {
      append({ kind: "notice", text: IMAGES_NOT_QUEUED });
      return;
    }
    let result: SteerResult | undefined;
    try {
      result = host.steer?.(text);
    } catch (error) {
      append({ kind: "error", text: errorMessage(error) });
      return;
    }
    // The line goes somewhere it is held now, whatever the brain answered: leaving it in the
    // prompt would steer, queue or send it twice.
    inputHandle.current?.edit(EMPTY_EDITOR);
    if (result?.status === "accepted") {
      trackSteer(result, text);
      return;
    }
    // A send is already waiting to interrupt this turn. It could not be steered, and a second
    // pending send would have to replace it — so this line takes the queue instead, behind the
    // first one, and neither is lost.
    if (interruptSend.current !== undefined) {
      replaceQueue(pushQueued(queueRef.current, text));
      return;
    }
    interruptSend.current = text;
    // The turn to cancel is the one `sending` owns, not the one the last render reported: this
    // key can arrive in the same batch as the return that started that turn. A card, a picker
    // and a menu still own escape from the frame, and the control guard still applies.
    if (escLayer(sending.current).kind === "turn") host.cancel();
  }

  /**
   * The steering row of one accepted steer, and what the turn's own answer does with it: an
   * applied steer is the turn's text, so it earns the transcript row a typed one would; an
   * unapplied steer never reached the turn, so it goes ahead of the queue and is sent next. A
   * rejected promise is read the same way — nothing can place the line, and the user's own
   * words are never dropped.
   */
  function trackSteer(result: Extract<SteerResult, { status: "accepted" }>, text: string): void {
    const { steerId } = result;
    setSteering((rows) => [...rows, { steerId, text }]);
    const settled = (taken: boolean): void => {
      setSteering((rows) => rows.filter((row) => row.steerId !== steerId));
      if (taken) appendAll(sentEntries(text));
      else discardSteer(text);
    };
    void result.applied.then(settled, () => settled(false));
  }

  /**
   * A steer the turn did not take, at the front of the queue — in the order the user steered
   * it. The group is kept whole (`pushDiscardedSteer`): a turn resolves every steer still
   * pending in arrival order, and prepending each as it lands would draw the last one first,
   * reversing a correction relative to the instruction it corrects.
   */
  function discardSteer(text: string): void {
    const placed = pushDiscardedSteer(discardedSteers.current, queueRef.current, text);
    discardedSteers.current = placed.group;
    replaceQueue(placed.queue);
  }

  /**
   * `/compact` (US-005): shed the conversation's history now, holding the turn slot while it
   * runs so a line typed meanwhile queues exactly as it does during a turn.
   *
   * The status carries the working line's `compacting` phase, so the screen says what it is
   * doing and the footer offers the same escape a turn does. The result's `tokensAfter`
   * becomes the footer's context reading: no session event carries it, and the compaction is
   * the only thing that can measure it. `finally` releases the slot and drains the queue
   * however the compaction settled — a rejection must not strand the input.
   *
   * A host with no `compact` at all, and one asked while a turn runs, both answer with a
   * notice and leave the turn slot alone.
   */
  async function compactTurn(): Promise<void> {
    const compact = host.compact;
    if (compact === undefined) {
      append({ kind: "notice", text: COMPACTION_UNAVAILABLE });
      return;
    }
    if (sending.current) {
      append({ kind: "notice", text: TURN_BUSY_NOTICE });
      return;
    }
    sending.current = true;
    setBusy(true);
    setStatus(compactingStatus);
    append({ kind: "notice", text: `${COMPACTING}${theme.glyphs.ellipsis}` });
    let settled = false;
    try {
      const result = await compact.call(host);
      setStatus((current) => ({ ...current, contextTokens: result.tokensAfter }));
      append({ kind: "notice", text: result.compacted ? compactedNotice(result) : NOTHING_TO_COMPACT });
      settled = true;
    } catch (error) {
      append({ kind: "error", text: errorMessage(error) });
    } finally {
      sending.current = false;
      // A queued model or mode switch is applied here, before the queue is drained, exactly
      // as a turn's own `finally` does — so a line queued after a switch goes on the model
      // the user switched to. It also clears the interrupt and quit-arm bookkeeping.
      await keys.finishTurn();
      setBusy(false);
      setStatus(stopTurn);
      // A settled compaction releases the queue as a completed turn does; a rejected one
      // hands the queued lines back to the prompt, where the user can send them again.
      drainQueue(settled ? { sent: true, status: "completed" } : { sent: false, status: undefined });
    }
  }

  /**
   * What the queue does once a send has settled, and the one place that decides it.
   *
   * A turn observed to have `completed` releases one message — the oldest — through `submit`,
   * the same path a typed return takes, so it expands its mentions, earns its own `user` row
   * and becomes the title and the history entry exactly as a typed line would. One message per
   * turn, in order: the rest wait for the next send's own end.
   *
   * Anything else — `cancelled`, `errored`, `timed_out`, a send that rejected, or a stream that
   * ended without a `turn_end` at all — sends nothing. The queued lines go back into the
   * prompt, the oldest first and above whatever has been typed since, so nothing the user wrote
   * is lost and they can edit it before returning. Restoring also empties the queue, which is
   * what keeps a later drain from sending a line twice.
   */
  function drainQueue(outcome: TurnOutcome): void {
    // A line that interrupted this turn goes first (US-004), whatever the turn's own outcome
    // was: the user asked for it before anything they queued earlier, and the queue stays
    // queued behind it. `submit` is the typed-return path, so it earns its own user row.
    const interrupted = interruptSend.current;
    if (interrupted !== undefined && !sending.current) {
      interruptSend.current = undefined;
      setDraft((current) => ({ ...current, history: [...current.history, interrupted] }));
      void submit(interrupted, false);
      return;
    }
    const queue = queueRef.current;
    if (queue.length === 0) return;
    if (!outcome.sent || outcome.status !== "completed") {
      replaceQueue(EMPTY_QUEUE);
      restorePrompt(queueToPrompt(queue, editorRef.current.text));
      return;
    }
    // A send another path already started owns the turn; the queue waits for its own end.
    if (sending.current) return;
    const taken = takeQueued(queue);
    if (taken === undefined) return;
    replaceQueue(taken.rest);
    // The line leaves the queue as a typed one would leave the prompt, so it joins the
    // prompt's history too: up recalls what was queued. The newest draft is read here — the
    // user may have typed since — and only its history changes, which is why the editor and
    // the browse position are carried over as they stand.
    setDraft((current) => ({ ...current, history: [...current.history, taken.text] }));
    // A queued line owns no draft: the pictures in the prompt are the next message's, so this
    // send must neither carry them nor empty them.
    void submit(taken.text, false);
  }

  /**
   * One composed message out. A message carrying images hands them over with its title — the
   * typed text without the placeholders, so the session is named by what was asked rather
   * than by `[Image #1]`; a message that is only the typed text keeps today's two-argument
   * call, and an expanded one keeps the typed text as its title.
   *
   * The draft that composed the message is spent the moment the message reaches the host, so
   * it is emptied here — before the call rather than after it. A turn that rejects, or one
   * still in flight, must not keep the numbers of the pictures it already took: the next
   * ctrl+v starts again at `[Image #1]`.
   *
   * Only a message the screen composed from the prompt owns a draft, and only that draft is
   * emptied. A picture attached while a send was being prepared is a draft the user started for
   * the next message, and a background notice — a job's, a task's — was never composed from the
   * prompt at all: it carries no draft, so the pending pictures stay exactly where they are.
   */
  async function sendMessage(
    prepared: ComposedSend,
    title: string,
    onEvent: (event: SessionEvent) => void,
  ): Promise<void> {
    const images = prepared.images ?? [];
    if (prepared.draft !== undefined) imageAttach.reset(prepared.draft);
    if (images.length > 0)
      await host.send(prepared.message, onEvent, { title: titleWithoutPlaceholders(title), images });
    else if (prepared.message === title) await host.send(prepared.message, onEvent);
    else await host.send(prepared.message, onEvent, { title });
  }

  async function sendTurn(
    composed: ComposedSend,
    prepare?: () => Promise<PreparedSend>,
    title = composed.message,
  ): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    turnEnd.current = undefined;
    // A new send starts a new turn, and a discarded group belongs to the turn that discarded
    // it: whatever an earlier turn discarded stays where it sits in the queue, and the first
    // steer *this* turn discards starts a group of its own at the front, ahead of it. Without
    // this, an interrupt-send that preserved the queue would hand the new turn the old turn's
    // group and append its own correction behind the one it was correcting.
    discardedSteers.current = undefined;
    // The statistics are this send's own: a turn is measured from its own events alone.
    turnEvents.current = [];
    let started = false;
    let sent = false;
    try {
      const prepared = prepare ? await prepare() : composed;
      if ("notice" in prepared) {
        append({ kind: "notice", text: prepared.notice });
        if (prepared.dropped !== undefined) {
          append({ kind: "notice", text: `${LINE_NOT_SENT}${prepared.dropped}` });
        }
        return false;
      }
      appendAll(sentEntries(prepared.message, prepared.images));
      setFollowToken((token) => token + 1);
      const onEvent = (event: SessionEvent): void => {
        if (event.type === "turn_start") started = true;
        handleEvent(event);
      };
      await sendMessage(prepared, title, onEvent);
      sent = true;
      return true;
    } catch (error) {
      append({ kind: "error", text: errorMessage(error) });
      return started;
    } finally {
      sending.current = false;
      // A queued model or mode switch is applied here, before the queue is drained, so the
      // message a user queued after switching models is sent on the model they switched to.
      await keys.finishTurn();
      setBusy(false);
      setStatus(stopTurn);
      drainQueue({ sent, status: turnEnd.current });
    }
  }

  const {
    running: jobs,
    tasks,
    backgroundable,
    noteUserTurn,
  } = useJobs(host, {
    idle: idleForJobNotice({
      turnRunning,
      bottomBlocked: bottomBlocked(ask, picker.model),
      canControl: keys.canControl(),
    }),
    deliver: (text) => sendTurn({ message: text }),
    note: (text) => append({ kind: "notice", text }),
  });

  // Use input bookkeeping so batched keys see completion and submission clears the draft.
  function completeCommand(name: string): void {
    inputHandle.current?.complete(`/${name} `);
  }

  function runCommandLine(name: string): void {
    inputHandle.current?.submit(`/${name}`);
  }

  /** Publish edits and claim the menus together, before the next batched key or render. */
  function changeDraft(next: InputDraft): void {
    // The image hook reads this instead of a rendered draft: a read that lands after an
    // `await` inserts into the text as it stands then, not as it stood at the key press.
    editorRef.current = next.editor;
    // And a refusal that lands after an `await` reads this count to see whether the prompt the
    // refused line came from is still the one standing: an attach or a typed key moves it too,
    // since both write through this handle.
    promptRevision.current += 1;
    slashKeys.sawPrompt(next.editor.text);
    mention.sawEditor(next.editor);
    setDraft(next);
  }

  /**
   * Esc on the question card: decline the question, then stop the chat turn it interrupted —
   * but only when the chat session itself asked it, a turn is running, and the keys can still
   * control it. A run ask's or a job's question asks as `"host"`: nothing here is waiting for
   * the answer, so the chat turn keeps running. The decline always comes first, so a question
   * is settled even on the turn it goes on to stop.
   */
  function dismissQuestion(pending: ChatPendingAsk): void {
    host.asks.declineQuestion(pending.requestId);
    if (askedBySession(pending) && turnRunning && keys.canControl()) host.cancel();
  }

  const columns = size.columns;
  const layoutOptions = { width: columns, theme, expanded };
  const lines = layoutTranscript(entries, layoutOptions);
  const header = headerLines({ state, version, cwd, home, width: columns, glyphs: theme.glyphs });
  const footer = footerModel({
    jobs,
    tasks,
    state,
    status,
    hint:
      copiedChars === undefined
        ? footerHint({
            quitArmed: keys.quitArmed(),
            clearArmed,
            busy: turnRunning,
            expanded,
            backgroundable,
            tmux,
            // The esc layer's own hint, which names what esc would close, deny or cancel now.
            layer: escHint !== undefined,
          })
        : "copied",
    layerHint: escHint,
    copiedChars,
    glyphs: theme.glyphs,
  });
  useJobsOpener({
    host,
    mouse,
    blocked: surfaceShown(bottomBlocked(ask, picker.model), menuShown(), mentionShown),
    footer,
    size,
    open: picker.open,
    note: (text) => append({ kind: "notice", text }),
  });

  // The bottom budget and the menus' shares of it are measured above the key handlers, beside
  // the claims that read them; the input is measured against what those leave.
  const inputBudget = Math.max(1, bottomBudget - INPUT_RULE_ROWS - menuRows - mentionView.rows);
  // The question card's draft is the screen's state: only then can the card's rows — the
  // answer box included — be measured before the frame is composed. It is the card's own
  // draft, keyed by the request it was typed for, so it never inherits the chat input's.
  const answer = ask?.type === "question" && ask.requestId === answerDraft.requestId ? answerDraft.draft : EMPTY_DRAFT;
  const askModel =
    ask === undefined
      ? undefined
      : askCardModel(ask, {
          canRemember: ask.type === "approval_requested" && host.asks.canRemember(ask),
          entries,
        });
  const cardRows =
    ask === undefined || askModel === undefined
      ? undefined
      : askCardLayout(askModel, {
          width: columns,
          budget: bottomBudget,
          theme,
          answer,
          expiresAt: ask.expiresAt,
        }).rows;
  const inputBottomRows = inputRows(draft, { width: columns, busy, container: columns, maxRows: inputBudget });
  const bottomRows = bottomRowsFor({
    ask: cardRows,
    picker: picker.model,
    input: aboveInputLines.length + inputBottomRows + menuRows + mentionView.rows,
    budget: bottomBudget,
  });
  const viewportHeight = Math.max(
    MIN_VIEWPORT_ROWS,
    usableRows - HEADER_ROWS - (working ? WORKING_ROWS : 0) - bottomRows - FOOTER_ROWS,
  );

  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="column">
        {header.map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the header's rows are positional and re-rendered whole.
          <FixedRow key={index}>
            <StyledLineView line={row} theme={theme} />
          </FixedRow>
        ))}
      </Box>
      <TranscriptViewport
        key={state.sessionId}
        mouse={mouse}
        top={HEADER_ROWS}
        onCopy={onCopy}
        onClick={(line) => setEntries((rows) => toggleTranscriptLine(rows, line, layoutOptions))}
        lines={lines}
        height={viewportHeight}
        theme={theme}
        active={viewportActive(keys.locked, picker.model)}
        followToken={followToken}
      />
      {working ? (
        <FixedRow>
          <StyledLineView line={working} theme={theme} />
        </FixedRow>
      ) : null}
      {/* Clip measured rows to preserve the footer. Cards take precedence over pickers and input. */}
      {ask !== undefined && askModel !== undefined ? (
        <Box height={bottomRows} overflow="hidden" flexDirection="column">
          <AskCard
            key={ask.requestId}
            ask={ask}
            model={askModel}
            controller={host.asks}
            width={columns}
            budget={bottomRows}
            theme={theme}
            answer={answer}
            onAnswerChange={(next) => setAnswerDraft({ requestId: ask.requestId, draft: next })}
            onDeclined={() => setHint(TELL_NAX_HINT)}
            onDismiss={() => dismissQuestion(ask)}
            active={!keys.locked}
          />
        </Box>
      ) : picker.model !== undefined ? (
        <Box height={bottomRows} overflow="hidden" flexDirection="column">
          <Picker
            model={picker.model}
            width={columns}
            theme={theme}
            budget={bottomBudget}
            active={!keys.locked}
            onChoose={picker.choose}
            onCycle={picker.cycle}
            onStop={picker.stop}
            onCancel={picker.cancel}
            onQuery={picker.setQuery}
            query={picker.model.query}
          />
        </Box>
      ) : (
        <Box height={bottomRows} overflow="hidden" flexDirection="column">
          {steeringLines.map((text, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steering rows are positional and drawn in arrival order.
            <FixedRow key={index}>
              <StyledLineView line={[{ text, color: "muted" }]} theme={theme} />
            </FixedRow>
          ))}
          {queueLines.map((text, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the queue's rows are positional and drawn oldest first.
            <FixedRow key={index}>
              <StyledLineView line={[{ text, color: "muted" }]} theme={theme} />
            </FixedRow>
          ))}
          <ChatInput
            draft={draft}
            onDraftChange={changeDraft}
            onPaste={imageAttach.onPaste}
            onSubmit={(message) => {
              setHint(undefined);
              void submit(message);
            }}
            onQueue={queueReturn}
            // A return can arrive in the same batch as the one that started a turn, before
            // any redraw: the turn's owner is `sending`, not the rendered `busy` flag.
            busyNow={() => sending.current}
            width={columns}
            theme={theme}
            active={!keys.locked}
            busy={busy}
            maxRows={inputBudget}
            hint={hint}
            yieldNavigation={mention.ownsNavigation}
            handle={inputHandle}
            onClearArmedChange={setClearArmed}
          />
          {menuShown() ? (
            <SlashMenu
              menu={menu}
              width={columns}
              theme={theme}
              active={!keys.locked}
              ownsKeys={menuOwnsKeys}
              maxRows={menuRows}
              onComplete={completeCommand}
              onRun={runCommandLine}
              onClose={() => {
                slashKeys.sawDismissal(menu.query);
                setDismissedQuery(menu.query);
              }}
            />
          ) : null}
          <MentionMenu view={mentionView} width={columns} theme={theme} />
        </Box>
      )}
      <Box flexDirection="row" justifyContent="space-between" width={columns} height={1} overflow="hidden">
        <StyledLineView line={footer.left} theme={theme} />
        <StyledLineView line={footer.right} theme={theme} />
      </Box>
    </Box>
  );
}
