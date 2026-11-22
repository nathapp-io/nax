/**
 * The full-screen view of one background shell, drawn in place of the chat while it is open.
 *
 * Structured like `AgentView`: two header rows (the title and a rule), the body in the chat's own
 * `TranscriptViewport` — so following the newest line and scrolling behave exactly as they do in
 * the agent view — and one footer row. What this view draws is the shell's bounded in-memory
 * tail; a tail that dropped older output names its log file instead of reaching back to disk.
 *
 * It is live: it follows the shell's tail (coalesced to one redraw per `SHELL_TAIL_REFRESH_MS`,
 * because the registry notifies per append), takes a registry change at once so a task that ends
 * while the view is open updates its header and footer without waiting, and ticks the elapsed
 * time every `SHELL_VIEW_TICK_MS` while the task runs. Escape hands the screen back to the chat;
 * `k` stops a running shell without closing the view, and a stop that fails says why in the
 * footer instead of disappearing. An unmount drops every subscription and cancels every timer.
 *
 * Time arrives through `_shellViewDeps.now()` and the timers through the same `schedule`/`cancel`
 * seams, so a test fixes the clock and arms nothing real. Output is display-only: the view has no
 * stdin and touches no file.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { Box, useInput } from "ink";
import { memo, type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import {
  type BackgroundTask,
  type ChatBackgroundTasks,
  type ChatShellOutput,
  SHELL_TAIL_REFRESH_MS,
} from "@/chat/background";
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

/** The key that stops a running shell from inside its view; it does nothing once it ended. */
const STOP_KEY = "k";

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

/** The two timers the view can hold at once, so an unmount cancels exactly what it armed. */
interface ShellViewTimers {
  /** The one coalesced redraw a burst of tail appends shares. */
  tail: TimerHandle | undefined;
  /** The running task's next elapsed-time tick. */
  tick: TimerHandle | undefined;
}

/**
 * Whether two records of the viewed task would draw the same header and footer — every field the
 * view reads of it, not the state alone. A stopped shell is finalised under the state it already
 * had (`stopped`), so comparing state alone swallows the change that carries its `exitCode` and
 * its `endedAt`, and the view would show a stopped shell with no outcome for good.
 */
function sameShellRow(left: BackgroundTask | undefined, right: BackgroundTask | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return (
    left.command === right.command &&
    left.description === right.description &&
    left.state === right.state &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.exitCode === right.exitCode &&
    left.logPath === right.logPath
  );
}

/** Cancel the timer held in `slot`, if any, through the seam it was armed with. */
function cancelTimer(timers: ShellViewTimers, slot: keyof ShellViewTimers): void {
  const handle = timers[slot];
  if (handle === undefined) return;
  _shellViewDeps.cancel(handle);
  timers[slot] = undefined;
}

/**
 * The revision a redraw is keyed on: a coalesced bump when this shell's tail changes, an
 * immediate one when the viewed task's own state changes, and a tick per `SHELL_VIEW_TICK_MS`
 * while it runs. Everything else the registry announces is somebody else's business.
 */
function useLiveShell(shells: ChatShellOutput, tasks: ChatBackgroundTasks, id: string): number {
  const [revision, refresh] = useState(0);
  const timers = useRef<ShellViewTimers>({ tail: undefined, tick: undefined });

  useEffect(() => {
    const held = timers.current;
    const offOutput = shells.onShellOutput((changedId) => {
      // The registry notifies per append, for every shell: only this one is drawn here, and a
      // burst of appends shares the one redraw already waiting.
      if (changedId !== id || held.tail !== undefined) return;
      held.tail = _shellViewDeps.schedule(() => {
        held.tail = undefined;
        refresh((current) => current + 1);
      }, SHELL_TAIL_REFRESH_MS);
    });
    return () => {
      offOutput();
      cancelTimer(held, "tail");
    };
  }, [shells, id]);

  useEffect(() => {
    // A hidden turn's Bash calls register and unregister by the dozen; only a change in what the
    // header or footer would draw of THIS task is worth a redraw, and it must not wait for a tick.
    let seenTask = tasks.get(id);
    const offChange = tasks.onChange(() => {
      const task = tasks.get(id);
      if (sameShellRow(seenTask, task)) return;
      seenTask = task;
      refresh((current) => current + 1);
    });
    return offChange;
  }, [tasks, id]);

  const running = tasks.get(id)?.state === "running";
  useEffect(() => {
    if (!running) return;
    const held = timers.current;
    // A timer that re-arms itself: the elapsed time keeps counting with no output at all.
    const arm = (): void => {
      held.tick = _shellViewDeps.schedule(() => {
        held.tick = undefined;
        refresh((current) => current + 1);
        arm();
      }, SHELL_VIEW_TICK_MS);
    };
    arm();
    return () => {
      cancelTimer(held, "tick");
    };
  }, [running]);

  return revision;
}

function ShellViewBase({
  shells,
  tasks,
  id,
  columns,
  rows,
  theme,
  mouse,
  onCopy,
  onClose,
}: ShellViewProps): ReactElement {
  _shellViewDeps.rendered();
  const revision = useLiveShell(shells, tasks, id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is what says the shell moved on.
  const task = useMemo(() => tasks.get(id), [tasks, id, revision]);
  const [stopError, setStopError] = useState<string | undefined>(undefined);
  // A task the registry no longer lists has no tail to show: a stale one must not be drawn.
  const view = task === undefined ? undefined : shells.taskTail(id);
  const body = useMemo(() => shellViewBody(view, task?.logPath), [view, task?.logPath]);
  const height = Math.max(0, usableFrameRows(rows) - AGENT_VIEW_HEADER_ROWS - FOOTER_ROWS);
  const title = shellViewTitle(task, id, _shellViewDeps.now());
  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (input !== STOP_KEY) return;
    // Only a running shell can be stopped; once it ended the key does nothing. The registry is
    // read again here rather than trusting the render that registered this handler.
    if (tasks.get(id)?.state !== "running") return;
    try {
      tasks.stop(id);
      setStopError(undefined);
    } catch (error) {
      // The view stays open — it was a stop that failed, not a reason to leave — and the footer
      // carries the reason in place of a hint that would claim the key still works.
      setStopError(errorMessage(error));
    }
  });
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
        <StyledLineView line={shellViewFooter(task, stopError)} theme={theme} />
      </FixedRow>
    </Box>
  );
}

/** Memoised: a redraw of the chat underneath hands it the same props and costs nothing. */
export const ShellView = memo(ShellViewBase);
