/**
 * The full-screen view of one background subagent, drawn in place of the chat while it is open.
 *
 * Read-only: the only key it owns besides scrolling is escape, which hands the screen back to
 * the chat that was mounted underneath, untouched. It draws the run's recorded events with the
 * chat's own reducer and layout, refreshes while the run records more, and keeps serving a
 * finished run for as long as the registry still holds it.
 */
import { Box, useInput } from "ink";
import { memo, type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import type { ChatBackgroundTasks } from "@/chat/background";
import {
  AGENT_VIEW_HEADER_ROWS,
  agentViewEntries,
  agentViewFooter,
  agentViewTitle,
  missingAgentTitle,
  toggledEntry,
  withOpened,
} from "./agent-view-model";
import { FixedRow } from "./FixedRow";
import { usableFrameRows } from "./frame-layout";
import { layoutTranscript } from "./layout";
import type { MouseEvents } from "./mouse-input";
import { StyledLineView } from "./styled-line";
import { TranscriptViewport } from "./TranscriptViewport";
import type { ChatTheme } from "./theme";
import { toggleTranscriptLine } from "./transcript-click";

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

/** Seams for the work a redraw must not repeat; a test counts the folds and layouts through them. */
export const _agentViewDeps = {
  fold: agentViewEntries,
  layout: layoutTranscript,
  /** Called once per render of the view, so a test can prove an unrelated redraw never reaches it. */
  rendered: (): void => {},
};

/**
 * A counter that moves when the task records an event or changes state; a burst of events is
 * folded into one step. Everything expensive is memoised on it, so a redraw the main chat caused
 * (a token of the turn running underneath) costs nothing here.
 */
function useTaskRevision(tasks: ChatBackgroundTasks, id: string): number {
  const [revision, refresh] = useState(0);
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
    // The registry announces every change to every task (a hidden turn's Bash calls register and
    // unregister foreground commands by the dozen); only a change in THIS task's state is ours.
    let seenState = tasks.get(id)?.state;
    const offState = tasks.onChange(() => {
      const state = tasks.get(id)?.state;
      if (state === seenState) return;
      seenState = state;
      refresh((revision) => revision + 1);
    });
    return () => {
      offEvents();
      offState();
      if (timer.current !== undefined) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [tasks, id]);
  return revision;
}

function AgentViewBase({ tasks, id, columns, rows, theme, mouse, onCopy, onClose }: AgentViewProps): ReactElement {
  _agentViewDeps.rendered();
  const revision = useTaskRevision(tasks, id);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is what says the task recorded more.
  const run = useMemo(() => tasks.agentRun(id), [tasks, id, revision]);
  const folded = useMemo(() => (run === undefined ? [] : _agentViewDeps.fold(run)), [run]);
  const entries = useMemo(() => withOpened(folded, opened), [folded, opened]);
  const layoutOptions = useMemo(() => ({ width: columns, theme, expanded }), [columns, theme, expanded]);
  const lines = useMemo(() => _agentViewDeps.layout(entries, layoutOptions), [entries, layoutOptions]);
  const usable = usableFrameRows(rows);
  const height = Math.max(0, usable - AGENT_VIEW_HEADER_ROWS - 1);
  useInput((input, key) => {
    if (key.escape) onClose();
    else if (key.ctrl && input === CTRL_O) setExpanded((current) => !current);
  });
  const toggle = (line: number): void => {
    const after = toggleTranscriptLine(entries, line, layoutOptions);
    const changed = toggledEntry(entries, after);
    if (changed !== undefined) setOpened((current) => new Map(current).set(changed.key, changed.open));
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

/** Memoised: a redraw of the chat underneath hands it the same props and costs nothing. */
export const AgentView = memo(AgentViewBase);
