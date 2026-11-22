/**
 * The full-screen shell view as data: the header row the view draws above the output, the hint
 * (or the error) in its footer, and the body lines drawn inside the chat's transcript viewport.
 *
 * The view is read-only, so every row is a plain `StyledLine` built here: the component owns the
 * frame's geometry and the viewport's scrolling, and nothing else. `formatDuration` is the chat's
 * one duration format, so a running shell's elapsed time reads exactly as a tool call's does.
 *
 * The body is the in-memory tail and nothing more: a truncated tail names its log file rather
 * than reaching back to disk for the bytes it dropped.
 */
import type { BackgroundTask, BackgroundTaskState, ShellTailView } from "@/chat/background";
import { formatDuration } from "./duration";
import { singleRow } from "./layout-lines";
import { type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatColorToken } from "./theme";

const SEPARATOR = " · ";
/** What the header says when the registry no longer lists the id it was opened for. */
const NOT_LISTED = "is no longer listed";
/** What the first body line says when older output was dropped from the tail. */
const TRUNCATED_NOTICE = "earlier output dropped";
const LOG_PATH_LABEL = "full log: ";
/** The exit code's label once the task ended. */
const EXIT_CODE_LABEL = "exit";
/** The view is read-only, and escape is the only way out of it. */
const SHELL_VIEW_HINT = "esc to return";
/** A running shell can be stopped from the view, which the hint names. */
const STOP_HINT = "k to stop";

/** The state as the header names it: running, succeeded, failed or stopped. */
const STATE_COLORS: Record<BackgroundTaskState, ChatColorToken> = {
  running: "accent",
  succeeded: "success",
  failed: "danger",
  stopped: "warning",
};

/** The span that separates two facts on a one-row header. */
function separator(): Span {
  return { text: SEPARATOR, color: "muted" };
}

/**
 * How long the task has run: from its start to now while it runs, and from its start to the end
 * it recorded once it ended. A missing or unparseable timestamp reads as a zero span, which is
 * `formatDuration`'s own rule.
 */
function elapsedMs(task: BackgroundTask, nowMs: number): number {
  const start = Date.parse(task.startedAt);
  const end = task.state === "running" || task.endedAt === undefined ? nowMs : Date.parse(task.endedAt);
  return end - start;
}

/** The title when the registry no longer lists the id the view was opened for. */
function missingShellTitle(id: string): StyledLine {
  return [
    { text: singleRow(id), color: "accent", bold: true },
    { text: ` ${NOT_LISTED}`, color: "muted" },
  ];
}

/**
 * The header's title row: the command, its description when it has one, the state, the elapsed
 * time, the exit code once the task ended, and the id. Everything a user needs to say which
 * shell this is and how it is doing, on the one row the frame gives it.
 */
export function shellViewTitle(task: BackgroundTask | undefined, id: string, nowMs: number): StyledLine {
  if (task === undefined) return missingShellTitle(id);
  const command: Span = { text: singleRow(sanitizeText(task.command)), color: "accent", bold: true };
  const description: readonly Span[] =
    task.description === undefined ? [] : [{ text: ` (${singleRow(sanitizeText(task.description))})`, color: "muted" }];
  const ended = task.state !== "running" && task.exitCode !== undefined;
  return [
    command,
    ...description,
    separator(),
    { text: task.state, color: STATE_COLORS[task.state], bold: true },
    separator(),
    { text: formatDuration(elapsedMs(task, nowMs)), color: "muted" },
    ...(ended ? [separator(), { text: `${EXIT_CODE_LABEL} ${task.exitCode}`, color: "danger" } satisfies Span] : []),
    separator(),
    { text: singleRow(sanitizeText(id)), color: "muted" },
  ];
}

/**
 * The footer's one row: the hint naming the keys the view owns, or — when stopping the shell
 * failed — that error in place of the hint, so the user is not told a key is still on offer.
 */
export function shellViewFooter(task: BackgroundTask | undefined, error?: string): StyledLine {
  if (error !== undefined) return [{ text: singleRow(error), color: "danger" }];
  const hint = task?.state === "running" ? `${SHELL_VIEW_HINT}${SEPARATOR}${STOP_HINT}` : SHELL_VIEW_HINT;
  return [{ text: hint, color: "muted" }];
}

/** The notice a truncated tail opens with: what was dropped, and where the whole log is. */
function truncatedNotice(logPath: string | undefined): StyledLine {
  if (logPath === undefined) return [{ text: TRUNCATED_NOTICE, color: "muted" }];
  return [{ text: `${TRUNCATED_NOTICE}; ${LOG_PATH_LABEL}${singleRow(sanitizeText(logPath))}`, color: "muted" }];
}

/** One tail line as one body line; the tail carries a shell's bytes, so every span is sanitised. */
function bodyLine(text: string): StyledLine {
  return [{ text: sanitizeText(text) }];
}

/**
 * The body: the truncated notice first when older output was dropped (naming the log path the
 * caller read from the task), then every retained tail line, oldest first. An absent view draws
 * nothing — the view has no tail to show, which is not the same as an empty one.
 */
export function shellViewBody(view: ShellTailView | undefined, logPath: string | undefined): readonly StyledLine[] {
  if (view === undefined) return [];
  const notice = view.truncated ? [truncatedNotice(logPath)] : [];
  return [...notice, ...view.lines.map(bodyLine)];
}
