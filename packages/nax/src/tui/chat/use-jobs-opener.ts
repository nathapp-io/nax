/**
 * The jobs picker's two gestures that need no slash command: ctrl+g and a left click on the
 * footer's job and task strip. Both read the registries at event time, so a click acts on what
 * runs now rather than on what the frame it was drawn from was counted at. ctrl+g always opens
 * the picker; a click opens the picker too, except when the strip counts exactly one task and
 * no job — a lone agent's full view is opened, a lone shell's live view is opened on a host that
 * reports shell output (and its output listing is shown where it does not), and ctrl+g still
 * reaches the picker for its ctrl+x. An ask card, an open picker or a shown slash menu owns the
 * screen, so both gestures are ignored then.
 */

import { useInput } from "ink";
import { useEffect, useRef } from "react";
import type { ChatHost } from "@/chat";
import type { BackgroundTask } from "@/chat/background/task-types";
import type { FrameRegion } from "./frame-layout";
import type { MouseEvents } from "./mouse-input";
import { _pickerDeps, type PickerEntry, taskEntry } from "./picker-model";
import type { PickerKind } from "./slash-commands";
import type { StyledLine } from "./styled-line";
import { opensTaskView } from "./use-agent-view";
import { spansWidth } from "./wrap";

/** ink reports ctrl+g as the letter `g` with the ctrl modifier. ctrl+j arrives as a line feed, so it is not used. */
export const JOBS_KEY = "g";
const JOBS_UNAVAILABLE = "jobs are not available in this session";

export interface FooterStripHitInput {
  /** The click's 1-based column. */
  readonly x: number;
  /** The click's 1-based row. */
  readonly y: number;
  /** The footer's 1-based row. */
  readonly footerRow: number;
  readonly columns: number;
  /** Display width of the footer's right line, which is drawn flush right. */
  readonly rightWidth: number;
  /** Display width of the strip at the start of the right line; 0 when none is drawn. */
  readonly stripWidth: number;
}

/** True when the cell is on the footer row inside the strip's columns. */
export function footerStripHit({ x, y, footerRow, columns, rightWidth, stripWidth }: FooterStripHitInput): boolean {
  if (stripWidth <= 0 || y !== footerRow) return false;
  const first = columns - rightWidth + 1;
  return x >= first && x <= first + stripWidth - 1;
}

export interface JobsOpenerInput {
  readonly host: ChatHost;
  readonly mouse?: MouseEvents;
  /** An ask card, a picker or the slash menu is shown. */
  readonly blocked: boolean;
  /** Event-time control guard: a render can lag an in-flight switch or close. */
  readonly canControl?: () => boolean;
  readonly footer: { readonly right: StyledLine; readonly stripWidth: number };
  readonly size: { readonly columns: number; readonly rows: number };
  /** Drawn zero-based allocation, not the terminal's last usable row. */
  readonly region: FrameRegion;
  open(kind: PickerKind): void;
  note(text: string): void;
  /** Append one row's output listing — what Enter on that row of the jobs picker draws. */
  showOutput(entry: PickerEntry): void;
  /**
   * Open the full-screen view of one background task: an agent's conversation, or a shell's live
   * output on a host that reports it. A shell on a host that reports none lists its output instead.
   */
  openAgent(id: string): void;
}

/** One cell of a left-button press. */
interface Press {
  readonly x: number;
  readonly y: number;
}

/** The running rows of a registry, read at event time; a host without the registry runs none. */
function runningTasks(host: ChatHost): readonly BackgroundTask[] {
  return (host.tasks?.list() ?? []).filter((task) => task.state === "running");
}

/** How many jobs the host reports running; the picker is what a click reaches when any do. */
function runningJobs(host: ChatHost): number {
  return (host.jobs?.list() ?? []).filter((job) => job.state === "running").length;
}

/**
 * The one task a strip click opens directly: exactly one running task and no running job. A
 * shell lists its output; an agent opens its full view. Anything else — two tasks, or one beside
 * a job — leaves the picker as the way in.
 */
function loneTask(host: ChatHost): BackgroundTask | undefined {
  const tasks = runningTasks(host);
  if (tasks.length !== 1 || runningJobs(host) !== 0) return undefined;
  return tasks[0];
}

/** Visibility, surface precedence and control locks must all allow the gesture. */
function blockedNow(input: JobsOpenerInput): boolean {
  return input.blocked || input.region.rows === 0 || input.canControl?.() === false;
}

/**
 * True when a release completes a press on the same cell of the footer strip: the arguments are
 * the press and its release, and nothing — an ask card, a picker, the slash menu — owns the screen.
 */
function stripClicked(input: JobsOpenerInput, pressed: Press, released: Press): boolean {
  if (blockedNow(input) || pressed.x !== released.x || pressed.y !== released.y) return false;
  const { footer, size } = input;
  return footerStripHit({
    x: released.x,
    y: released.y,
    footerRow: input.region.top + 1,
    columns: size.columns,
    rightWidth: spansWidth(footer.right),
    stripWidth: footer.stripWidth,
  });
}

/**
 * A completed click on the strip: the lone task's view — an agent's conversation, or a shell's
 * live output on a host that reports one — the lone shell's output listing where it reports none,
 * or the jobs picker. `markBlocked` stands the gesture down at once, so a second click in the
 * same batch opens nothing.
 */
function openFromStrip(input: JobsOpenerInput, markBlocked: () => void): void {
  const task = loneTask(input.host);
  // A lone task has nothing to choose between, so it opens without the picker.
  if (task !== undefined && opensTaskView(input.host, task.id)) {
    markBlocked();
    input.openAgent(task.id);
    return;
  }
  if (task !== undefined) {
    input.showOutput(taskEntry(task, _pickerDeps.now()));
    return;
  }
  markBlocked();
  input.open("jobs");
}

/** Open the jobs picker from ctrl+g or a press and release on one cell of the footer strip. */
export function useJobsOpener(input: JobsOpenerInput): void {
  // Read at event time: batched keys and mouse reports can precede the render that follows them.
  const latest = useRef(input);
  latest.current = input;
  const press = useRef<Press | undefined>(undefined);

  useInput((key, modifiers) => {
    if (!modifiers.ctrl || key !== JOBS_KEY) return;
    const { host, open, note } = latest.current;
    if (blockedNow(latest.current)) return;
    if (host.jobs === undefined && host.tasks === undefined) {
      note(JOBS_UNAVAILABLE);
      return;
    }
    latest.current = { ...latest.current, blocked: true };
    open("jobs");
  });

  const { mouse } = input;
  useEffect(() => {
    if (!mouse) return;
    return mouse.subscribe((event) => {
      if (event.button !== "left") return;
      if (event.kind === "press") {
        press.current = blockedNow(latest.current) ? undefined : { x: event.x, y: event.y };
        return;
      }
      if (event.kind !== "release") return;
      const pressed = press.current;
      press.current = undefined;
      if (pressed === undefined) return;
      const current = latest.current;
      if (!stripClicked(current, pressed, event)) return;
      openFromStrip(current, () => {
        latest.current = { ...latest.current, blocked: true };
      });
    });
  }, [mouse]);
}
