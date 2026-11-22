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
 * the screen last drew cannot see the call yet. A marked id the transcript did not have waits
 * instead of being forgotten — the update below retries it whenever the transcript changes, so a
 * command that prints once and then waits still shows its line as soon as its card appears.
 * A host without `shellOutput` (an ACP-backed agent, whose shells nax does not run) subscribes
 * to nothing.
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

export function useForegroundTails(input: UseForegroundTailsInput): void {
  const shellOutput = input.host.shellOutput;
  const setEntries = useRef(input.setEntries);
  setEntries.current = input.setEntries;
  /** The ids a notification named whose `Bash` entry has not carried a tail yet. */
  const waiting = useRef<Set<string> | null>(null);
  waiting.current ??= new Set();
  const ids = waiting.current;
  const handle = useRef<TimerHandle | undefined>(undefined);

  useEffect(() => {
    if (shellOutput === undefined) return undefined;
    let live = true;
    const flush = (): void => {
      handle.current = undefined;
      if (!live || ids.size === 0) return;
      // The update is for the ids waiting right now; a notification that arrives later arms its
      // own timer. The updater is handed the transcript as it is now, not as the notification's
      // render drew it: an id whose `tool_call` entry committed in between is drawn, and the ones
      // the transcript still cannot place stay waiting.
      const marked = new Set(ids);
      setEntries.current((rows) => {
        const update = applyTails(rows, marked, shellOutput);
        for (const id of update.matched) ids.delete(id);
        return update.rows;
      });
    };
    const unsubscribe = shellOutput.onShellOutput((id) => {
      // Never dropped, even for an id the transcript cannot place yet: the update below checks
      // the entries it is handed, which is the transcript as it is when the update lands.
      ids.add(id);
      if (handle.current !== undefined) return;
      // `setTimeout`, not `setInterval`: the armed update is cancelled mid-flight on unmount.
      handle.current = _foregroundTailsDeps.schedule(flush, SHELL_TAIL_REFRESH_MS);
    });
    return () => {
      live = false;
      unsubscribe();
      if (handle.current !== undefined) _foregroundTailsDeps.cancel(handle.current);
      handle.current = undefined;
      ids.clear();
    };
  }, [shellOutput, ids]);

  // A call whose output arrived before its `tool_call` entry committed: the entry appearing is
  // the moment its tail becomes drawable. A transcript that still shows none of the waiting calls
  // costs nothing; an update that changes nothing hands back the same array, so this settles.
  useEffect(() => {
    if (shellOutput === undefined || ids.size === 0) return;
    if (![...ids].some((id) => namesRunningBash(input.entries, id))) return;
    const marked = new Set(ids);
    setEntries.current((rows) => {
      const update = applyTails(rows, marked, shellOutput);
      for (const id of update.matched) ids.delete(id);
      return update.rows;
    });
  }, [shellOutput, ids, input.entries]);
}
