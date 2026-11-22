/**
 * The full-screen view of one background subagent, drawn in place of the chat while it is open.
 *
 * Read-only: the only key it owns besides scrolling is escape, which hands the screen back to
 * the chat that was mounted underneath, untouched. It draws the run's recorded events with the
 * chat's own reducer and layout, refreshes while the run records more, and keeps serving a
 * finished run for as long as the registry still holds it.
 */
import { Box, useInput } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import type { ChatBackgroundTasks } from "@/chat/background";
import {
  AGENT_VIEW_HEADER_ROWS,
  agentViewEntries,
  agentViewFooter,
  agentViewTitle,
  missingAgentTitle,
} from "./agent-view-model";
import { FixedRow } from "./FixedRow";
import { usableFrameRows } from "./frame-layout";
import { layoutTranscript } from "./layout";
import type { MouseEvents } from "./mouse-input";
import { StyledLineView } from "./styled-line";
import { TranscriptViewport } from "./TranscriptViewport";
import type { ChatTheme } from "./theme";
import { toggleTranscriptLine } from "./transcript-click";
import type { TranscriptEntry } from "./transcript-model";

/** ink reports ctrl+o as the letter `o` with the ctrl modifier. */
const CTRL_O = "o";
/** How long a burst of recorded events waits before one redraw; a token stream would otherwise redraw per token. */
export const AGENT_VIEW_REFRESH_MS = 80;

export interface AgentViewProps {
  readonly tasks: ChatBackgroundTasks;
  readonly id: string;
  readonly columns: number;
  readonly rows: number;
  readonly theme: ChatTheme;
  readonly mouse?: MouseEvents;
  readonly onCopy?: (text: string) => void;
  /** Escape: hand the screen back to the chat. */
  onClose(): void;
}

/** Redraw when the task records an event or changes state; a burst is folded into one redraw. */
function useTaskRefresh(tasks: ChatBackgroundTasks, id: string): void {
  const [, refresh] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // A timer that can be cleared mid-flight: the view may close while a redraw is waiting.
    const schedule = (): void => {
      if (timer.current !== undefined) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        refresh((revision) => revision + 1);
      }, AGENT_VIEW_REFRESH_MS);
    };
    const offEvents = tasks.onAgentEvents((taskId) => {
      if (taskId === id) schedule();
    });
    // A state change is rare and worth showing at once.
    const offState = tasks.onChange(() => refresh((revision) => revision + 1));
    return () => {
      offEvents();
      offState();
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [tasks, id]);
}

/** The entries with the user's click-opened rows applied; the fold alone never opens one. */
function withOpened(
  entries: readonly TranscriptEntry[],
  opened: ReadonlyMap<number, boolean>,
): readonly TranscriptEntry[] {
  if (opened.size === 0) return entries;
  return entries.map((entry, index) =>
    opened.has(index) ? Object.assign({}, entry, { open: opened.get(index) }) : entry,
  );
}

/** The index of the one entry a toggle changed, with its new `open`; undefined when nothing changed. */
function toggledEntry(
  before: readonly TranscriptEntry[],
  after: readonly TranscriptEntry[],
): { index: number; open: boolean } | undefined {
  const index = after.findIndex((entry, at) => entry !== before[at]);
  const entry = after[index];
  if (entry === undefined || !("open" in entry)) return undefined;
  return { index, open: entry.open === true };
}

export function AgentView({ tasks, id, columns, rows, theme, mouse, onCopy, onClose }: AgentViewProps): ReactElement {
  useTaskRefresh(tasks, id);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<ReadonlyMap<number, boolean>>(new Map());
  const run = tasks.agentRun(id);
  const folded = run === undefined ? [] : agentViewEntries(run);
  const entries = withOpened(folded, opened);
  const layoutOptions = { width: columns, theme, expanded };
  const lines = layoutTranscript(entries, layoutOptions);
  const usable = usableFrameRows(rows);
  const height = Math.max(0, usable - AGENT_VIEW_HEADER_ROWS - 1);
  useInput((input, key) => {
    if (key.escape) onClose();
    else if (key.ctrl && input === CTRL_O) setExpanded((current) => !current);
  });
  const toggle = (line: number): void => {
    const after = toggleTranscriptLine(entries, line, layoutOptions);
    const changed = toggledEntry(entries, after);
    if (changed !== undefined) setOpened((current) => new Map(current).set(changed.index, changed.open));
  };
  const title = run === undefined ? missingAgentTitle(id) : agentViewTitle(run);
  return (
    <Box flexDirection="column" width={columns}>
      <FixedRow>
        <StyledLineView line={title} theme={theme} />
      </FixedRow>
      <FixedRow>
        <StyledLineView line={[{ text: theme.glyphs.rule.repeat(columns), color: "border" }]} theme={theme} />
      </FixedRow>
      <TranscriptViewport
        mouse={mouse}
        top={AGENT_VIEW_HEADER_ROWS}
        onCopy={onCopy}
        onClick={toggle}
        lines={lines}
        height={height}
        theme={theme}
        active
      />
      <FixedRow>
        <StyledLineView line={agentViewFooter()} theme={theme} />
      </FixedRow>
    </Box>
  );
}
