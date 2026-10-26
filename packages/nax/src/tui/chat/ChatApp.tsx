/**
 * The chat screen — the full-screen composition of the fixed header, the scrolling
 * transcript viewport, the live working line, the bottom region and the one-line footer.
 *
 * The component owns no drawing of its own: every region is a pure model rendered by its
 * own view. `headerLines` composes the three rows above the transcript, `layoutTranscript`
 * turns the entry union into styled lines, `TranscriptViewport` windows them, `workingLine`
 * draws the turn's live state and `footerModel` the one-row footer. The screen's job is the
 * arithmetic between them: the viewport gets every row the fixed regions do not claim
 * (`rows - header - working - bottom - footer`), never fewer than one, so a terminal too
 * small for those regions loses transcript rather than the footer or the input.
 *
 * The screen owns the transcript (`reduceTranscript`), the turn status
 * (`reduceTurnStatus`), the input's `InputDraft` — so unmounting the input for an ask card
 * loses neither the typed text nor the history — and the entry sources the session does not
 * provide: the welcome banner at mount and after `/clear`, a `listing` for the commands
 * that list and a `notice` for every other command's text, and `notice` / `warning` /
 * `error` entries for the host's own statements. It also owns the slash menu's state — the
 * query, the escape that put it away and what the two keys that complete a line write back
 * into the prompt — while the rows themselves are the model's (`slashMenuQueryState`), so
 * the rows it reserves under the input are the rows the menu draws.
 *
 * Terminal size comes from `useStdout` (24 rows and 80 columns when the stream cannot say)
 * and is re-read on the stream's `resize` event. The working line's clock is a `setTimeout`
 * chain of `WORKING_TICK_MS`, cleared with `clearTimeout` when the turn ends or the screen
 * unmounts; `setInterval` is not used because the effect's cleanup could not stop a tick
 * already queued.
 *
 * Keys have one owner each, and the first matching surface wins: an ask card owns escape,
 * return and the arrows; the picker and the slash menu own theirs; the input
 * owns escaping an idle prompt and the typing keys; the viewport owns pageUp, pageDown,
 * home, end and shift+arrow. The screen itself owns the two that apply in every state —
 * ctrl+o toggles collapsed detail, and escape interrupts a running turn, but never while an
 * ask card is up (the card owns escape, and it must not reach `host.cancel()`) and never
 * while the slash menu is open (the menu's escape puts the menu away, keeps the text and
 * arms nothing). ctrl-c and shift+tab stay with `useChatKeys`. A send bumps the viewport's
 * follow token, so a message typed while scrolled up brings the screen back to the newest
 * line.
 */

import type { SessionEvent } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box, useInput, useStdout } from "ink";
import { type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatHost, ChatMcpState } from "@/chat";
import type { McpServerEvent } from "@/mcp";
import { buildCommandMessage } from "@/prompts";
import { runCommandShellLines } from "@/resources";
import { NAX_VERSION } from "@/version";
import { AskCard, askCardLayout } from "./AskCard";
import { askCardModel } from "./ask-card";
import { bottomBlocked, bottomRowsFor, viewportActive } from "./bottom-region";
import { ChatInput, type ChatInputHandle, EMPTY_DRAFT, INPUT_RULE_ROWS, type InputDraft, inputRows } from "./ChatInput";
import {
  type FooterHint,
  footerModel,
  headerLines,
  IDLE_STATUS,
  reduceTurnStatus,
  type TurnStatus,
  WORKING_TICK_MS,
  workingLine,
} from "./chat-status";
import { layoutTranscript } from "./layout";
import { Picker, useChatPicker } from "./Picker";
import { SlashMenu } from "./SlashMenu";
import { parseSlashCommand, runSlashCommand, type SlashCommand, type SlashOutcome } from "./slash-commands";
import { slashMenuItems, slashMenuQueryState } from "./slash-menu";
import { StyledLineView } from "./styled-line";
import { TranscriptViewport } from "./TranscriptViewport";
import { type ChatTheme, resolveChatTheme } from "./theme";
import { reduceTranscript, type TranscriptEntry } from "./transcript-model";
import { useChatKeys } from "./useChatKeys";

export interface ChatAppProps {
  readonly host: ChatHost;
  /** Absent: colour off, Unicode glyphs — what a captured environment would resolve. */
  readonly theme?: ChatTheme;
  /** Absent: the running build's version. */
  readonly version?: string;
  /** Absent: the repository root the host reports. */
  readonly cwd?: string;
  /** Absent: no home prefix to shorten the header's path with. */
  readonly home?: string;
}

/** Rows the header always claims: the product line, the path line and the rule. */
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
const CLEAR = "clear";
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

/** One transcript entry, drawn as one of the screen's own fixed rows. */
function FixedRow({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Box height={1} overflow="hidden">
      {children}
    </Box>
  );
}

/** The server's latest connection event; teardown (`closed`) is not a status. */
function lastServerEvent(events: readonly McpServerEvent[], id: string): McpServerEvent | undefined {
  return events.findLast((event) => event.serverId === id);
}

/**
 * The banner the screen opens with, and clears back to: what the session has to work with.
 * A host without a catalogue or an MCP pool counts zero rather than failing.
 */
function welcomeEntry(host: ChatHost): TranscriptEntry {
  const catalog = host.catalog;
  const mcp: ChatMcpState | undefined = host.mcp;
  const servers = mcp?.servers ?? [];
  const events = mcp?.events() ?? [];
  return {
    kind: "welcome",
    skills: catalog?.skills.length ?? 0,
    commands: catalog?.commands.length ?? 0,
    agents: catalog?.agents.length ?? 0,
    mcpServers: servers.length,
    mcpConnected: servers.filter((server) => lastServerEvent(events, server.id)?.kind === "connected").length,
  };
}

/**
 * The gesture the footer offers, in precedence order: an armed quit, then an armed clear,
 * then a running turn, then expanded detail, then the idle hint. Only one is ever shown, so
 * the warning-coloured quit hint is never hidden behind something the screen is merely doing.
 */
function footerHint(input: { quitArmed: boolean; clearArmed: boolean; busy: boolean; expanded: boolean }): FooterHint {
  if (input.quitArmed) return "quit";
  if (input.clearArmed) return "clear";
  if (input.busy) return "busy";
  if (input.expanded) return "expanded";
  return "idle";
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
 * Where a slash command's shown text goes: a listing entry per run for the commands that
 * list, one notice entry per statement for everything else.
 */
interface SlashSink {
  show(text: string): void;
  flush(): void;
}

function slashSink(title: string | undefined, append: (entry: TranscriptEntry) => void): SlashSink {
  const rows: string[] = [];
  return {
    show(text) {
      if (title === undefined) {
        append({ kind: "notice", text });
        return;
      }
      rows.push(text);
    },
    flush() {
      if (title === undefined || rows.length === 0) return;
      append({ kind: "listing", title, text: rows.join("\n") });
    },
  };
}

export function ChatApp({
  host,
  theme = DEFAULT_THEME,
  version = NAX_VERSION,
  cwd = host.repoRoot,
  home = "",
}: ChatAppProps): ReactElement {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => terminalSize(stdout));
  const [entries, setEntries] = useState<readonly TranscriptEntry[]>(() => [welcomeEntry(host)]);
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
  const append = useCallback((entry: TranscriptEntry) => {
    setEntries((rows) => [...rows, entry]);
  }, []);
  const showError = useCallback((error: unknown) => append({ kind: "error", text: errorMessage(error) }), [append]);
  const keys = useChatKeys({ host, running: sending, refresh: update, onError: showError });
  /** The picker a `picker` outcome opens (US-027): the list, and what its keys do. */
  const picker = useChatPicker({ host, runControl: keys.runControl, onError: showError });
  const ask = host.asks.pending()[0];
  /** A turn is in flight from the send until its stream settles — the footer's busy rule. */
  const turnRunning = busy || status.running;
  // The menu offers what the host's catalogue adds to the built-ins. A session's catalogue is
  // fixed for its life, so the items are built once per host rather than on every tick.
  const menuItems = useMemo(() => slashMenuItems(host), [host]);
  /**
   * The slash menu is open while the prompt holds a `/` query that matches something, while
   * no ask card owns the bottom of the screen (a card's keys are its own), and while no
   * escape has put this prompt's menu away. A dismissal lasts only until the text next
   * changes, so the remembered query is dropped as soon as the prompt holds anything else.
   */
  const menu = slashMenuQueryState({
    items: menuItems,
    query: draft.editor.text,
    dismissed: dismissedQuery,
    blocked: bottomBlocked(ask, picker.model),
  });
  if (menu.reopen) setDismissedQuery(undefined);

  /**
   * The two keys the screen itself owns, in every state: ctrl+o toggles collapsed detail, and
   * escape interrupts a running turn. Escape is claimed only when no ask card is up — the card
   * owns it, and a card's escape must never reach `host.cancel()` — only while no picker is
   * shown (a picker's escape cancels the list), only while no slash menu is open (the menu's
   * escape puts the menu away and nothing else), only while a turn runs, and only while the
   * hook's control guard is open: on an idle screen the input owns it (where a first escape
   * arms the clear), and once close has begun the host is already closed, so a late escape
   * would throw instead of letting teardown finish.
   */
  useInput((input, key) => {
    if (key.ctrl && input === CTRL_O) {
      setExpanded((current) => !current);
      return;
    }
    if (!key.escape || ask !== undefined || picker.model !== undefined || menu.open) return;
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
  useEffect(() => host.asks.onChange(update), [host, update]);
  useEffect(() => {
    const resourceNotice = host.resourceNotice?.();
    if (resourceNotice) append({ kind: "notice", text: resourceNotice });
  }, [host, append]);

  const state = host.current();
  const notice = host.notice();
  const warn = state.mode === "full" && state.sandbox?.kind === "unavailable";
  useEffect(() => {
    if (notice) append({ kind: "notice", text: notice });
  }, [notice, append]);
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
    if (outcome === undefined) {
      if (command.name === CLEAR) setEntries([welcomeEntry(host)]);
      return;
    }
    if (outcome.kind === "picker") {
      picker.open(outcome.picker);
      return;
    }
    if (outcome.kind === "send") {
      await sendTurn(outcome.message);
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
      return { message: buildCommandMessage(expandedLines.text, rest) };
    });
  }

  async function submit(message: string): Promise<void> {
    const command = parseSlashCommand(message);
    if (!command) {
      await sendTurn(message);
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

  // Wait for send's metadata drain before reopening the session for a queued mode.
  async function sendTurn(
    message: string,
    prepare?: () => Promise<{ message: string } | { notice: string }>,
  ): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const prepared = prepare ? await prepare() : { message };
      if ("notice" in prepared) {
        append({ kind: "notice", text: prepared.notice });
        return;
      }
      append({ kind: "user", text: prepared.message });
      setFollowToken((token) => token + 1);
      await host.send(prepared.message, handleEvent);
    } catch (error) {
      append({ kind: "error", text: errorMessage(error) });
    } finally {
      sending.current = false;
      await keys.finishTurn();
      setBusy(false);
      // A stream that ends without `turn_end` — a rejection mid-turn is the usual way — still
      // ends the turn: the working line and the busy footer must not outlive it.
      setStatus(stopTurn);
    }
  }

  /**
   * The menu's two actions go through the input's own bookkeeping: `complete` writes the
   * same draft ref the next keystroke in a batch reduces, and `submit` disarms the clear and
   * empties the prompt exactly as a typed return does. The menu is only ever drawn beside the
   * input — an ask card hides it — so the handle is set whenever a menu key can run.
   */
  function completeCommand(name: string): void {
    inputHandle.current?.complete(`/${name} `);
  }

  function runCommandLine(name: string): void {
    inputHandle.current?.submit(`/${name}`);
  }

  const columns = size.columns;
  const lines = layoutTranscript(entries, { width: columns, theme, expanded });
  const header = headerLines({ state, version, cwd, home, width: columns, glyphs: theme.glyphs });
  const working = workingLine(status, nowMs, theme.glyphs);
  const footer = footerModel({
    state,
    status,
    hint: footerHint({ quitArmed: keys.quitArmed(), clearArmed, busy: turnRunning, expanded }),
    glyphs: theme.glyphs,
  });
  // The rows the bottom region may claim: everything the fixed regions and the viewport's
  // minimum do not. Both the input and the ask card are measured against it, so whatever they
  // wrap to, the footer stays on the screen's last row.
  const bottomBudget = Math.max(
    1,
    size.rows - HEADER_ROWS - (working ? WORKING_ROWS : 0) - FOOTER_ROWS - MIN_VIEWPORT_ROWS,
  );
  // The menu's rows are the bottom region's too: they are reserved before the input is
  // measured, so an open menu shortens the viewport instead of pushing the footer off screen.
  const inputBudget = Math.max(1, bottomBudget - INPUT_RULE_ROWS - menu.rows);
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
    input: inputBottomRows + menu.rows,
    budget: bottomBudget,
  });
  const viewportHeight = Math.max(
    MIN_VIEWPORT_ROWS,
    size.rows - HEADER_ROWS - (working ? WORKING_ROWS : 0) - bottomRows - FOOTER_ROWS,
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
      {/*
        The bottom region is clipped to the rows reserved above: a row that ever measured short
        loses its tail rather than growing the frame, so the footer stays on the screen's last
        row whatever the terminal, the draft or an ask does. The ask card is measured by
        `askCardLayout` — every row it draws, the wrapped elision label and the countdown
        included — and its own budget already drops the middle of an oversized card, so the
        clipping only ever trims a card on a terminal too short for its answer box. A picker
        replaces the input entirely, its frame and rows measured by `pickerRows`; a card that
        arrives while one is open takes the region back, because its question comes first.
      */}
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
            onCancel={picker.cancel}
          />
        </Box>
      ) : (
        <Box height={bottomRows} overflow="hidden" flexDirection="column">
          <ChatInput
            draft={draft}
            onDraftChange={setDraft}
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
            yieldNavigation={menu.open}
            handle={inputHandle}
            onClearArmedChange={setClearArmed}
          />
          {menu.open ? (
            <SlashMenu
              menu={menu}
              width={columns}
              theme={theme}
              active={!keys.locked}
              onComplete={completeCommand}
              onRun={runCommandLine}
              onClose={() => setDismissedQuery(menu.query)}
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
