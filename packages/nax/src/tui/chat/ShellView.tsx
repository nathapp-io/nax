/**
 * The full-screen view of one background shell, drawn in place of the chat while it is open.
 *
 * Structured like `AgentView`: two header rows (the title and a rule), the body in the chat's own
 * `TranscriptViewport` — so following the newest line and scrolling behave exactly as they do in
 * the agent view — and one footer row. What this view draws is the shell's bounded in-memory
 * tail; a tail that dropped older output names its log file instead of reaching back to disk.
 *
 * Read-only as it stands: it owns no key and no subscription yet (US-007 adds the live tail and
 * the ESC/k keys). Time arrives through `_shellViewDeps.now()`, so the header's elapsed time is
 * arithmetic a test can fix, and the timers US-007 arms reach the runtime through the same seam.
 */
import { Box } from "ink";
import { memo, type ReactElement, useMemo } from "react";
import type { ChatBackgroundTasks, ChatShellOutput } from "@/chat/background";
import { AGENT_VIEW_HEADER_ROWS } from "./agent-view-model";
import { FixedRow } from "./FixedRow";
import { usableFrameRows } from "./frame-layout";
import type { MouseEvents } from "./mouse-input";
import { shellViewBody, shellViewFooter, shellViewTitle } from "./shell-view-model";
import { StyledLineView } from "./styled-line";
import { TranscriptViewport } from "./TranscriptViewport";
import type { ChatTheme } from "./theme";

/** An armed timer's opaque handle: the runtime's here, the fake clock's in a test. */
type TimerHandle = ReturnType<typeof setTimeout> | number;

/** How often a running shell's header refreshes its elapsed time, with or without new output. */
export const SHELL_VIEW_TICK_MS = 1000;

/** The footer's one row, below the body. */
const FOOTER_ROWS = 1;

export interface ShellViewProps {
  /** Where the shell's tail comes from; display only, nothing here reaches the model. */
  readonly shells: ChatShellOutput;
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

/**
 * Seams for the work a redraw must not repeat: the clock the header reads, the timers the view
 * arms, and a counter a test uses to prove an unrelated redraw never reaches the view.
 */
export const _shellViewDeps = {
  /** Epoch milliseconds, the base the header's elapsed time is measured from. */
  now: (): number => Date.now(),
  /** Arm a timer, returning the handle `cancel` takes. */
  schedule: (callback: () => void, ms: number): TimerHandle => globalThis.setTimeout(callback, ms),
  /** Clear a handle `schedule` returned. */
  cancel: (handle: TimerHandle): void => globalThis.clearTimeout(handle),
  /** Called once per render of the view, so a test can prove an unrelated redraw never reaches it. */
  rendered: (): void => {},
};

function ShellViewBase({ shells, tasks, id, columns, rows, theme, mouse, onCopy }: ShellViewProps): ReactElement {
  _shellViewDeps.rendered();
  const task = tasks.get(id);
  const title = shellViewTitle(task, id, _shellViewDeps.now());
  // A task the registry no longer lists has no tail to show: a stale one must not be drawn.
  const view = task === undefined ? undefined : shells.taskTail(id);
  const body = useMemo(() => shellViewBody(view, task?.logPath), [view, task?.logPath]);
  const height = Math.max(0, usableFrameRows(rows) - AGENT_VIEW_HEADER_ROWS - FOOTER_ROWS);
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
        lines={body}
        height={height}
        theme={theme}
        active
      />
      <FixedRow>
        <StyledLineView line={shellViewFooter(task)} theme={theme} />
      </FixedRow>
    </Box>
  );
}

/** Memoised: a redraw of the chat underneath hands it the same props and costs nothing. */
export const ShellView = memo(ShellViewBase);
