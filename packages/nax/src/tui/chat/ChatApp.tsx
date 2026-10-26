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
 * `error` entries for the host's own statements.
 *
 * Terminal size comes from `useStdout` (24 rows and 80 columns when the stream cannot say)
 * and is re-read on the stream's `resize` event. The working line's clock is a `setTimeout`
 * chain of `WORKING_TICK_MS`, cleared with `clearTimeout` when the turn ends or the screen
 * unmounts; `setInterval` is not used because the effect's cleanup could not stop a tick
 * already queued.
 */

import type { SessionEvent } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box, useStdout } from "ink";
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { ChatHost, ChatMcpState, ChatPendingAsk } from "@/chat";
import type { McpServerEvent } from "@/mcp";
import { buildCommandMessage } from "@/prompts";
import { runCommandShellLines } from "@/resources";
import { NAX_VERSION } from "@/version";
import { AskPrompt } from "./AskPrompt";
import { ChatInput, EMPTY_DRAFT, type InputDraft, inputRows } from "./ChatInput";
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
import { parseSlashCommand, runSlashCommand, type SlashCommand, type SlashOutcome } from "./slash-commands";
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

/** The rows the legacy `AskPrompt` draws: the tool line, the reason and the key options. */
const APPROVAL_ASK_ROWS = 3;
/** The extra line an approval outside the sandbox adds. */
const UNSANDBOXED_ASK_ROWS = 1;
/** A question ask: the question line and its one-row input. */
const QUESTION_ASK_ROWS = 2;

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
 * The rows the bottom region claims while an ask is pending. `AskPrompt` draws its own
 * rows, so the screen reserves them here; US-023 replaces the card and takes over the
 * measurement with it.
 */
function askRows(ask: ChatPendingAsk): number {
  if (ask.type === "question") return QUESTION_ASK_ROWS;
  return APPROVAL_ASK_ROWS + (ask.unsandboxed ? UNSANDBOXED_ASK_ROWS : 0);
}

/**
 * The gesture the footer offers, in precedence order: an armed clear, then a running turn,
 * then expanded detail, then the idle hint. The quit hint joins ahead of all of them in
 * US-021, once `useChatKeys` can say a quit is armed.
 */
function footerHint(input: { clearArmed: boolean; busy: boolean; expanded: boolean }): FooterHint {
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
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const sending = useRef(false);
  const [, refresh] = useState(0);
  /** ctrl+o toggles this in US-021; until then the transcript is always collapsed. */
  const expanded = false;

  const update = useCallback(() => refresh((revision) => revision + 1), []);
  const append = useCallback((entry: TranscriptEntry) => {
    setEntries((rows) => [...rows, entry]);
  }, []);
  const showError = useCallback((error: unknown) => append({ kind: "error", text: errorMessage(error) }), [append]);
  const keys = useChatKeys({ host, running: sending, refresh: update, onError: showError });
  const ask = host.asks.pending()[0];

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

  const columns = size.columns;
  const lines = layoutTranscript(entries, { width: columns, theme, expanded });
  const header = headerLines({ state, version, cwd, home, width: columns, glyphs: theme.glyphs });
  const working = workingLine(status, nowMs, theme.glyphs);
  const footer = footerModel({
    state,
    status,
    hint: footerHint({ clearArmed, busy: busy || status.running, expanded }),
    glyphs: theme.glyphs,
  });
  const bottomRows = ask ? askRows(ask) : inputRows(draft, { width: columns, busy });
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
      <TranscriptViewport lines={lines} height={viewportHeight} theme={theme} active={!keys.locked} />
      {working ? (
        <FixedRow>
          <StyledLineView line={working} theme={theme} />
        </FixedRow>
      ) : null}
      {/*
        The bottom region is clipped to the rows reserved above: a prompt row that turns out
        wider than measured loses its tail rather than growing the frame, so the footer stays
        on the screen's last row whatever the terminal and the draft do.
      */}
      <Box height={bottomRows} overflow="hidden">
        {ask ? (
          <AskPrompt key={ask.requestId} ask={ask} controller={host.asks} active={!keys.locked} />
        ) : (
          <ChatInput
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={(message) => {
              void submit(message);
            }}
            width={columns}
            theme={theme}
            active={!keys.locked}
            busy={busy}
            onClearArmedChange={setClearArmed}
          />
        )}
      </Box>
      <Box flexDirection="row" justifyContent="space-between" width={columns} height={1} overflow="hidden">
        <StyledLineView line={footer.left} theme={theme} />
        <StyledLineView line={footer.right} theme={theme} />
      </Box>
    </Box>
  );
}
