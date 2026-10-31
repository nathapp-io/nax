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

import type { SessionEvent } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box, useInput, useStdout } from "ink";
import { type ReactElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ChatHost, expandChatMentions, parseMentionMessage, parseSkillInvocation } from "@/chat";
import { buildCommandMessage } from "@/prompts";
import { runCommandShellLines } from "@/resources";
import { NAX_VERSION } from "@/version";
import { AskCard, askCardLayout } from "./AskCard";
import { askCardModel } from "./ask-card";
import { bottomBlocked, bottomRowsFor, menuRowsFor, viewportActive } from "./bottom-region";
import { ChatInput, type ChatInputHandle, EMPTY_DRAFT, INPUT_RULE_ROWS, type InputDraft, inputRows } from "./ChatInput";
import {
  footerModel,
  headerLines,
  IDLE_STATUS,
  reduceTurnStatus,
  type TurnStatus,
  WORKING_TICK_MS,
  workingLine,
} from "./chat-status";
import { FixedRow } from "./FixedRow";
import { layoutTranscript } from "./layout";
import { mentionTranscriptEntries } from "./mention-entries";
import type { MouseEvents } from "./mouse-input";
import { Picker, useChatPicker } from "./Picker";
import { SlashMenu } from "./SlashMenu";
import { sessionTranscript } from "./session-transcript";
import { parseSlashCommand, runSlashCommand, type SlashCommand, type SlashOutcome } from "./slash-commands";
import { slashMenuItemsForModel, slashMenuQueryState } from "./slash-menu";
import { slashSink } from "./slash-sink";
import { StyledLineView } from "./styled-line";
import { TranscriptViewport } from "./TranscriptViewport";
import { type ChatTheme, resolveChatTheme } from "./theme";
import { toggleTranscriptLine } from "./transcript-click";
import { reduceTranscript, type TranscriptEntry } from "./transcript-model";
import { footerHint, useClipboardFeedback } from "./use-clipboard-feedback";
import { useJobs } from "./use-jobs";
import { FRAME_SLACK_ROWS, useJobsOpener } from "./use-jobs-opener";
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
}

/** Environment seam; sampled once per mounted screen. */
export const _chatAppDeps = {
  tmux: (): string | undefined => Bun.env.TMUX,
  /** Attach a typed message's mentions to it once, here in the TUI, before any brain sees it. */
  expandMentions: expandChatMentions,
};

/**
 * What a typed message must carry to be worth expanding: a mention token's `@`, or the
 * trailer of an expanded message pasted back in (which `formatMentionMessage` re-parses). A
 * message with neither keeps today's exact send, so nothing else pays for the expansion.
 */
const MENTION_TRIGGERS: readonly string[] = ["@", "</nax-mentions"];

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
/** What the input offers after a declined ask, until the next submit says what to do instead. */
const TELL_NAX_HINT = "tell nax what to do instead";
/** ink reports ctrl+o as the letter `o` with the ctrl modifier, so the key is its `input`. */
const CTRL_O = "o";
/** The theme a caller that passes none gets; resolved once, since it is a pure constant. */
const DEFAULT_THEME = resolveChatTheme({ env: {}, colorLevel: 0 });

/**
 * The listing a slash command's shown text becomes, by command name. A command here shows
 * one listing entry per run; every other command's text becomes a notice entry instead.
 */
const LISTING_TITLES: ReadonlyMap<string, string> = new Map([
  ["help", "Commands"],
  ["skills", "Skills"],
  ["plugins", "Plugins"],
  ["mcp", "MCP servers"],
  ["agents", "Agents"],
  ["sessions", "Sessions"],
  ["cost", "Cost"],
]);

/** A question card's draft and the request it was typed for: a new request starts empty. */
interface QuestionAnswer {
  readonly requestId: string;
  readonly draft: InputDraft;
}

/** No question answered yet — the state a fresh screen opens on. */
const NO_ANSWER: QuestionAnswer = { requestId: "", draft: EMPTY_DRAFT };

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
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

/** Notices wait until neither a turn, a bottom-region surface nor host control owns the screen. */
function idleForJobNotice(input: { turnRunning: boolean; bottomBlocked: boolean; canControl: boolean }): boolean {
  return !input.turnRunning && !input.bottomBlocked && input.canControl;
}

/** An ask card, a picker or the slash menu is drawn in the bottom region. */
function surfaceShown(cardOrPicker: boolean, menu: boolean): boolean {
  return cardOrPicker || menu;
}

/** Whether a typed message carries anything for the expander to resolve. */
function needsMentionExpansion(text: string): boolean {
  return MENTION_TRIGGERS.some((trigger) => text.includes(trigger));
}

/**
 * What one sent message becomes in the transcript: a skill's invocation, the mention rows of
 * the envelope nax expanded it into, or the message as it stands. `replayUser` reads a stored
 * message the same way, so a live turn and a resumed one draw alike.
 */
function sentEntries(message: string): readonly TranscriptEntry[] {
  const skill = parseSkillInvocation(message);
  if (skill) return [{ kind: "skill", ...skill }];
  const parsed = parseMentionMessage(message);
  return parsed === undefined ? [{ kind: "user", text: message }] : mentionTranscriptEntries(parsed);
}

export function ChatApp({
  host,
  mouse,
  theme = DEFAULT_THEME,
  version = NAX_VERSION,
  cwd = host.repoRoot,
  home = "",
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
  const sending = useRef(false);
  const [, refresh] = useState(0);

  const update = useCallback(() => refresh((revision) => revision + 1), []);
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
  // Measure first: an invisible menu must not claim navigation or run unseen commands.
  const working = workingLine(status, nowMs, theme.glyphs);
  const usableRows = size.rows - FRAME_SLACK_ROWS;
  const bottomBudget = Math.max(
    1,
    usableRows - HEADER_ROWS - (working ? WORKING_ROWS : 0) - FOOTER_ROWS - MIN_VIEWPORT_ROWS,
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
  if (menu.reopen) {
    slashKeys.sawDismissal(undefined);
    setDismissedQuery(undefined);
  }

  // Ctrl+o toggles detail; escape interrupts only when no bottom surface or control owns it.
  useInput((input, key) => {
    if (key.ctrl && input === CTRL_O) {
      setExpanded((current) => !current);
      return;
    }
    if (!key.escape || ask !== undefined || picker.model !== undefined || menuShown()) return;
    if (!turnRunning || !keys.canControl()) return;
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
  const handleEvent = useCallback((event: SessionEvent) => {
    setEntries((rows) => reduceTranscript(rows, event));
    setStatus((current) => reduceTurnStatus(current, event));
    if (event.type === "turn_start") setNowMs(Date.now());
  }, []);

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
    if (outcome.kind === "picker") {
      picker.open(outcome.picker);
      return;
    }
    if (outcome.kind === "send") {
      noteUserTurn();
      await sendTurn(outcome.message, undefined, `/${command.name}${command.rest}`);
      return;
    }
    const { name, template, rest } = outcome;
    await sendTurn(`/${name}${rest}`, async () => {
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

  /**
   * The typed message as every brain receives it: the same text with the content of each
   * mention appended. Resolved against the process cwd the screen was handed and the repo
   * the host reports, once per send — the title and the draft history keep the typed text.
   */
  async function prepareMentions(text: string): Promise<{ message: string }> {
    const expanded = await _chatAppDeps.expandMentions(text, { cwd, repoRoot: host.repoRoot });
    return { message: expanded.message };
  }

  async function submit(message: string): Promise<void> {
    const command = parseSlashCommand(message);
    if (!command) {
      noteUserTurn();
      await sendTurn(message, needsMentionExpansion(message) ? () => prepareMentions(message) : undefined);
      return;
    }
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

  async function sendTurn(
    message: string,
    prepare?: () => Promise<{ message: string } | { notice: string }>,
    title = message,
  ): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    let started = false;
    try {
      const prepared = prepare ? await prepare() : { message };
      if ("notice" in prepared) {
        append({ kind: "notice", text: prepared.notice });
        return false;
      }
      appendAll(sentEntries(prepared.message));
      setFollowToken((token) => token + 1);
      const onEvent = (event: SessionEvent): void => {
        if (event.type === "turn_start") started = true;
        handleEvent(event);
      };
      if (prepared.message === title) await host.send(prepared.message, onEvent);
      else await host.send(prepared.message, onEvent, { title });
      return true;
    } catch (error) {
      append({ kind: "error", text: errorMessage(error) });
      return started;
    } finally {
      sending.current = false;
      await keys.finishTurn();
      setBusy(false);
      setStatus(stopTurn);
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
    deliver: (text) => sendTurn(text),
    note: (text) => append({ kind: "notice", text }),
  });

  // Use input bookkeeping so batched keys see completion and submission clears the draft.
  function completeCommand(name: string): void {
    inputHandle.current?.complete(`/${name} `);
  }

  function runCommandLine(name: string): void {
    inputHandle.current?.submit(`/${name}`);
  }

  /** Publish edits and claim the menu together, before the next batched key or render. */
  function changeDraft(next: InputDraft): void {
    slashKeys.sawPrompt(next.editor.text);
    setDraft(next);
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
          })
        : "copied",
    copiedChars,
    glyphs: theme.glyphs,
  });
  useJobsOpener({
    host,
    mouse,
    blocked: surfaceShown(bottomBlocked(ask, picker.model), menuShown()),
    footer,
    size,
    open: picker.open,
    note: (text) => append({ kind: "notice", text }),
  });

  // The bottom budget and the menu's share of it are measured above the key handlers, beside
  // the claim that reads them; the input is measured against what those two leave.
  const inputBudget = Math.max(1, bottomBudget - INPUT_RULE_ROWS - menuRows);
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
    input: inputBottomRows + menuRows,
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
          <ChatInput
            draft={draft}
            onDraftChange={changeDraft}
            onSubmit={(message) => {
              setHint(undefined);
              void submit(message);
            }}
            width={columns}
            theme={theme}
            active={!keys.locked}
            busy={busy}
            maxRows={inputBudget}
            hint={hint}
            yieldNavigation={menuOwnsKeys}
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
        </Box>
      )}
      <Box flexDirection="row" justifyContent="space-between" width={columns} height={1} overflow="hidden">
        <StyledLineView line={footer.left} theme={theme} />
        <StyledLineView line={footer.right} theme={theme} />
      </Box>
    </Box>
  );
}
