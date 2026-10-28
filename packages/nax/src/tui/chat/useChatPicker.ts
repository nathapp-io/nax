/** Picker lifecycle and synchronous pending effort state. */
import { useCallback, useRef, useState } from "react";
import type { ChatSessionRow } from "@/chat";
import {
  type ChatHost,
  type ChatHostState,
  type ChatMode,
  cycleEffort,
  type EffortLevel,
  isEffortLevel,
  withEffort,
} from "@/chat";
import { type PickerEntry, type PickerModel, pickerModel } from "./picker-model";
import type { PickerKind } from "./slash-commands";

function pickerMode(value: string): ChatMode {
  return value === "full" ? "full" : "guarded";
}
interface PickerState {
  readonly kind: PickerKind;
  readonly query: string;
  readonly pending: ReadonlyMap<string, EffortLevel>;
  /** The saved sessions; absent while `listSessions()` has not settled. */
  readonly sessions?: readonly ChatSessionRow[];
  /** What a choice warned about, drawn under the entries until the picker closes. */
  readonly warning?: string;
}

export interface ChatPickerOptions {
  readonly host: ChatHost;
  /** `useChatKeys.runControl`: every host action a choice names goes through the guard. */
  runControl(task: () => Promise<void>): Promise<boolean>;
  onError(error: unknown): void;
}

/** What the screen holds while a picker is open. */
export interface ChatPicker {
  /** The picker the screen draws, or undefined while the input owns the bottom region. */
  readonly model: PickerModel | undefined;
  /** Open the picker a `picker` outcome named; a resume list starts loading its sessions. */
  open(kind: PickerKind): void;
  setQuery(query: string): void;
  /** Escape: the picker goes and nothing is chosen. */
  cancel(): void;
  /** Return: the host action the chosen entry names, or the warning an in-use session earns. */
  choose(entry: PickerEntry): void;
  cycle(entry: PickerEntry, step: 1 | -1): void;
}

/** The host action a choice names, decided by which picker asked. */
function actionFor(host: ChatHost, kind: PickerKind, entry: PickerEntry): Promise<void> {
  if (kind === "model") return host.switchTo({ model: entry.original ?? entry.value });
  if (kind === "mode") return host.switchTo({ mode: pickerMode(entry.value) });
  if (kind === "effort") {
    return isEffortLevel(entry.value)
      ? host.switchTo({ model: withEffort(host.current().model, entry.value) })
      : Promise.resolve();
  }
  return host.resume({ id: entry.value });
}

/** The warning a held session earns: choosing it again would run two processes at once. */
function heldWarning(sessionId: string, pid: number): string {
  return `session ${sessionId} is in use by pid ${pid}`;
}

/** The model one picker state draws, read against the session it is shown over. */
function modelOf(state: PickerState, current: ChatHostState, models: readonly string[]): PickerModel {
  return pickerModel({
    kind: state.kind,
    query: state.query,
    pending: state.pending,
    models,
    currentModel: current.model,
    currentMode: current.mode,
    ...(state.sessions === undefined ? {} : { sessions: state.sessions }),
    ...(state.warning === undefined ? {} : { warning: state.warning }),
  });
}

/**
 * The picker the screen shows, and the three things its keys do. The screen owns the draft
 * and the transcript; the picker owns only the list it is showing.
 *
 * A resume list is asynchronous, so what it is waiting on has to outlive the render that
 * asked for it: `openings` counts every opening and closing, and a `listSessions()` that
 * settles after the list it was opened for is gone is dropped. That is what makes a
 * rejection after an escape — or after a second `/resume` — neither an error the user never
 * asked about nor a stale list over the wrong picker.
 */
export function useChatPicker({ host, runControl, onError }: ChatPickerOptions): ChatPicker {
  const [state, setState] = useState<PickerState | undefined>(undefined);
  /** Counts openings, so a `listSessions()` that settles late is dropped rather than drawn. */
  const openings = useRef(0);
  // Updated before scheduling a render: repeated arrows and Return share the newest map.
  const pending = useRef<ReadonlyMap<string, EffortLevel>>(new Map());

  const cancel = useCallback((): void => {
    openings.current += 1;
    pending.current = new Map();
    setState(undefined);
  }, []);

  const open = useCallback(
    (kind: PickerKind): void => {
      openings.current += 1;
      const opening = openings.current;
      pending.current = new Map();
      setState({ kind, query: "", pending: pending.current });
      if (kind !== "resume") return;
      void host.listSessions().then(
        (sessions) => {
          if (openings.current !== opening) return;
          setState((current) => (current === undefined ? current : { ...current, sessions }));
        },
        (error: unknown) => {
          if (openings.current !== opening) return;
          openings.current += 1;
          setState(undefined);
          onError(error);
        },
      );
    },
    [host, onError],
  );

  const choose = useCallback(
    (entry: PickerEntry): void => {
      const kind = state?.kind;
      if (kind === undefined) return;
      // A session another process holds is not resumed from here: the row warns instead, and
      // the list stays open so the user can pick another one. The authoritative lock is the
      // host's (`host.resume`), which is why this is only what the storage layer reported.
      if (kind === "resume" && entry.heldPid !== undefined) {
        const warning = heldWarning(entry.value, entry.heldPid);
        setState((current) => (current === undefined ? current : { ...current, warning }));
        return;
      }
      // The list has answered: it goes whether the host accepts the choice or not, so the
      // input is back for the error entry a rejection leaves behind.
      openings.current += 1;
      setState(undefined);
      const level = pending.current.get(entry.value);
      const chosen =
        kind === "model" && level !== undefined ? { ...entry, original: withEffort(entry.value, level) } : entry;
      pending.current = new Map();
      void runControl(() => actionFor(host, kind, chosen));
    },
    [state, host, runControl],
  );

  const current = state === undefined ? undefined : host.current();
  const model = state === undefined || current === undefined ? undefined : modelOf(state, current, host.models);
  const setQuery = useCallback((query: string): void => {
    setState((current) => (current?.kind === "model" ? { ...current, query } : current));
  }, []);
  const cycle = useCallback(
    (entry: PickerEntry, step: 1 | -1): void => {
      if (state?.kind !== "model") return;
      const initial = entry.effortLabel ?? "default";
      const level = pending.current.get(entry.value) ?? (isEffortLevel(initial) ? initial : "default");
      const next = new Map(pending.current);
      next.set(entry.value, cycleEffort(level, step));
      pending.current = next;
      setState((current) => (current?.kind === "model" ? { ...current, pending: next } : current));
    },
    [state?.kind],
  );
  return { model, open, cancel, choose, setQuery, cycle };
}
