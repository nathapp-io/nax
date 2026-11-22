/**
 * Live foreground shell output (chat-live-shell-output US-005): keeps the live tail of every
 * running `Bash` call in the transcript, so a long build or test run shows progress rather than
 * nothing until it ends (#3022).
 *
 * The host's shell-output registry announces which call id changed, not what it now says, and a
 * chatty command appends thousands of times. So a notification only marks the id and arms one
 * timer; every notification that arrives inside `SHELL_TAIL_REFRESH_MS` joins that same update,
 * which reads each marked call's tail once and replaces only the entries it changed. Replacing
 * the entry object is what makes the layout cache lay the card out again, and the click mapping
 * reads the same entries, so the card's height and its click targets stay in step.
 *
 * The update re-checks inside the `setEntries` updater that the id still names a running `Bash`
 * entry: a result can land, or the entry be replaced, between the notification and the update.
 * That check is also why a notification is never dropped when it arrives: a call's first output
 * reaches the host before React commits the `tool_call` entry that carries its id, and the frame
 * the screen last drew cannot see the call yet.
 *
 * So an id lives in one of two places, never both. Until its refresh window elapses it is
 * `pending`: only the armed timer draws it, and a transcript change in the meantime draws
 * nothing, which is what keeps an unrelated `tool_call` or `tool_result` from smuggling a tail
 * onto the screen ahead of the window. An id whose window elapsed while the transcript still
 * could not place it is `waiting`: the timer is spent, so the moment the transcript grows its
 * card is the moment the tail becomes drawable, and the update below retries exactly those ids
 * then — so a command that prints once and then waits still shows its line as soon as its card
 * appears. A host without `shellOutput` (an ACP-backed agent, whose shells nax does not run)
 * subscribes to nothing.
 */
import { useEffect, useRef } from "react";
import type { ChatHost } from "@/chat";
import { type ChatShellOutput, SHELL_TAIL_REFRESH_MS } from "@/chat/background";
import type { TranscriptEntry } from "./transcript-model";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** An armed timer's opaque handle: the runtime's here, the fake clock's in a test. */
type TimerHandle = ReturnType<typeof setTimeout> | number;

type SetEntries = (update: (rows: readonly TranscriptEntry[]) => readonly TranscriptEntry[]) => void;

export interface UseForegroundTailsInput {
  readonly host: ChatHost;
  /**
   * The transcript as the last render drew it. A notification is never checked against it — it
   * only says when to retry a call whose tail arrived before its entry did.
   */
  readonly entries: readonly TranscriptEntry[];
  readonly setEntries: SetEntries;
}

/**
 * Injected seams: the refresh timer only. A test drives it from a fake clock instead of the
 * wall clock, so it says exactly when a coalesced update lands.
 */
export const _foregroundTailsDeps: {
  schedule: (callback: () => void, ms: number) => TimerHandle;
  cancel: (handle: TimerHandle) => void;
} = {
  schedule: (callback, ms) => globalThis.setTimeout(callback, ms),
  cancel: (handle) => globalThis.clearTimeout(handle),
};

/** Whether a call's tail already says what the entry carries, so the entry can stay as it is. */
function sameLines(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((text, index) => text === right[index]);
}

/** The entry with the call's current tail, or the entry itself when it already carries it. */
function withLiveTail(entry: ToolEntry, output: ChatShellOutput): ToolEntry {
  const lines = output.foregroundTail(entry.callId)?.lines;
  if (sameLines(entry.liveTail, lines)) return entry;
  const { liveTail: _liveTail, ...rest } = entry;
  return lines === undefined ? rest : { ...rest, liveTail: lines };
}

/** Whether `id` names a running `Bash` call of the transcript `entries`. */
function namesRunningBash(entries: readonly TranscriptEntry[], id: string): boolean {
  return entries.some(
    (entry) => entry.kind === "tool" && entry.callId === id && entry.name === "Bash" && entry.status === "running",
  );
}

/** The transcript an update produced, and the ids a running `Bash` entry carried. */
interface TailUpdate {
  readonly rows: readonly TranscriptEntry[];
  /** The marked ids the transcript had a running `Bash` entry for; nothing waits on them again. */
  readonly matched: ReadonlySet<string>;
}

/**
 * The transcript with every running Bash entry of `ids` carrying its call's current tail. An
 * entry the update does not touch keeps its object, and a transcript nothing changed is the
 * input array itself, so the layout cache recomputes only the cards the tail moved.
 */
function applyTails(rows: readonly TranscriptEntry[], ids: ReadonlySet<string>, output: ChatShellOutput): TailUpdate {
  let changed = false;
  const matched = new Set<string>();
  const next = rows.map((row) => {
    if (row.kind !== "tool" || row.status !== "running" || row.name !== "Bash") return row;
    if (!ids.has(row.callId)) return row;
    matched.add(row.callId);
    const updated = withLiveTail(row, output);
    if (updated === row) return row;
    changed = true;
    return updated;
  });
  return { rows: changed ? next : rows, matched };
}

/** What one coalesced update is handed: the transcript setter, the ids, and the two id sets. */
interface CommitTailsInput {
  readonly setEntries: SetEntries;
  /** The ids this update draws; a notification that arrives later gets its own update. */
  readonly marked: ReadonlySet<string>;
  readonly output: ChatShellOutput;
  /** The ids whose window is spent and whose `Bash` entry the transcript still lacks. */
  readonly waiting: Set<string>;
}

/**
 * Lay `marked`'s tails into the transcript and settle the ids: one the transcript placed stops
 * waiting, one it still cannot place waits for the transcript to change. The updater is what
 * knows which is which, because only it sees the rows the update lands on.
 */
function commitTails(input: CommitTailsInput): void {
  input.setEntries((rows) => {
    const update = applyTails(rows, input.marked, input.output);
    for (const id of input.marked) {
      if (update.matched.has(id)) input.waiting.delete(id);
      else input.waiting.add(id);
    }
    return update.rows;
  });
}

export function useForegroundTails(input: UseForegroundTailsInput): void {
  const shellOutput = input.host.shellOutput;
  const setEntries = useRef(input.setEntries);
  setEntries.current = input.setEntries;
  /** The ids a notification named whose refresh window has not elapsed yet. */
  const pending = useRef<Set<string> | null>(null);
  pending.current ??= new Set();
  const pendingIds = pending.current;
  /** The ids whose window elapsed while the transcript still had no running `Bash` entry. */
  const waiting = useRef<Set<string> | null>(null);
  waiting.current ??= new Set();
  const waitingIds = waiting.current;
  const handle = useRef<TimerHandle | undefined>(undefined);

  useEffect(() => {
    if (shellOutput === undefined) return undefined;
    let live = true;
    const flush = (): void => {
      handle.current = undefined;
      if (!live || pendingIds.size === 0) return;
      // The update is for the ids notified inside this window; a notification that arrives later
      // arms its own timer. The updater is handed the transcript as it is now, not as the
      // notification's render drew it: an id whose `tool_call` entry committed in between is
      // drawn, and the ones the transcript still cannot place start waiting for it to change.
      const marked = new Set(pendingIds);
      pendingIds.clear();
      commitTails({ setEntries: setEntries.current, marked, output: shellOutput, waiting: waitingIds });
    };
    const unsubscribe = shellOutput.onShellOutput((id) => {
      // Never dropped, even for an id the transcript cannot place yet: the update below checks
      // the entries it is handed, which is the transcript as it is when the update lands.
      pendingIds.add(id);
      // A fresh notification reopens the id's window, so the retry below must not draw it before
      // the timer this notification arms.
      waitingIds.delete(id);
      if (handle.current !== undefined) return;
      // `setTimeout`, not `setInterval`: the armed update is cancelled mid-flight on unmount.
      handle.current = _foregroundTailsDeps.schedule(flush, SHELL_TAIL_REFRESH_MS);
    });
    return () => {
      live = false;
      unsubscribe();
      if (handle.current !== undefined) _foregroundTailsDeps.cancel(handle.current);
      handle.current = undefined;
      pendingIds.clear();
      waitingIds.clear();
    };
  }, [shellOutput, pendingIds, waitingIds]);

  // A call whose output arrived before its `tool_call` entry committed: the entry appearing is
  // the moment its tail becomes drawable. Only ids whose refresh window is already spent are
  // retried — an id still inside its window is the armed timer's to draw, so an unrelated
  // transcript change draws nothing. A transcript that still shows none of the waiting calls
  // costs nothing; an update that changes nothing hands back the same array, so this settles.
  useEffect(() => {
    if (shellOutput === undefined || waitingIds.size === 0) return;
    const ready = new Set([...waitingIds].filter((id) => namesRunningBash(input.entries, id)));
    if (ready.size === 0) return;
    for (const id of ready) waitingIds.delete(id);
    commitTails({ setEntries: setEntries.current, marked: ready, output: shellOutput, waiting: waitingIds });
  }, [shellOutput, waitingIds, input.entries]);
}
