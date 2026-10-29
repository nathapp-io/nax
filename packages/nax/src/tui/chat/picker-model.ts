/** Pure picker rows, filtering, and host-choice metadata. */
import { parseModelSpec } from "@nathapp/nax-agent";
import {
  type ChatMode,
  type ChatSessionRow,
  EFFORT_LEVELS,
  type EffortLevel,
  modelEffort,
  sessionTitleText,
} from "@/chat";
import { oneLine } from "./layout-lines";
import { relativeTime } from "./relative-time";
import type { PickerKind } from "./slash-commands";
import { sanitizeText } from "./styled-line";

const LOADING = "loading…";
const NO_SESSIONS = "no saved sessions";
/** The title each kind of picker draws, in the words the design fixes. */
const TITLES = {
  model: "Switch model",
  resume: "Resume a session",
  mode: "Permission mode",
  effort: "Reasoning effort",
} as const satisfies Record<PickerKind, string>;

/** The permission modes in the order the picker offers them, with what each one means. */
const MODE_CHOICES = [
  { mode: "guarded", detail: "asks before risky actions" },
  { mode: "full", detail: "never asks; runs outside the sandbox when it is unavailable" },
] as const satisfies readonly { readonly mode: ChatMode; readonly detail: string }[];

/**
 * Injected seams. `now` is the clock a session row's relative time is read at, so a picker's
 * rows and the test that asserts them measure against the same instant.
 */
export const _pickerDeps = { now: (): number => Date.now() };

/** One row a picker offers, and what choosing it names. */
export interface PickerEntry {
  /** A base model, permission mode, or session id. */
  readonly value: string;
  readonly label: string;
  /** The configured (or current) model id, preserved until effort is cycled. */
  readonly original?: string;
  /** Raw suffix text, default, or the pending cycled level. */
  readonly effortLabel?: string;
  /** The muted effort, mode explanation, or session age column. */
  readonly detail?: string;
  /** True for the value the session is already on. */
  readonly current?: boolean;
  /** The process holding a saved session, when the storage layer reports one. */
  readonly heldPid?: number;
}

/** The single row a picker draws under its entries: `loading…`, or what a choice warned about. */
export interface PickerNote {
  readonly text: string;
  readonly tone: "muted" | "warning";
}

/** What one picker shows: the title it carries and the rows it offers. */
export interface PickerModel {
  readonly kind: PickerKind;
  readonly query?: string;
  readonly title: string;
  readonly entries: readonly PickerEntry[];
  /** Full model choices, so queued query edits can broaden matches before the next render. */
  readonly allEntries?: readonly PickerEntry[];
  readonly note?: PickerNote;
}

export interface PickerModelInput {
  readonly pending?: ReadonlyMap<string, EffortLevel>;
  readonly effortLevels?: readonly EffortLevel[];
  readonly kind: PickerKind;
  readonly query?: string;
  /** The host's models, in catalogue order — the model picker's rows. */
  readonly models: readonly string[];
  /** The model the session is on, marked `(current)`. */
  readonly currentModel: string;
  /** The permission mode the session is on, marked `(current)`. */
  readonly currentMode: ChatMode;
  /** The saved sessions; absent while `listSessions()` has not settled. */
  readonly sessions?: readonly ChatSessionRow[];
  /** What a choice warned about — a session another process holds. */
  readonly warning?: string;
  readonly nowMs?: number;
}

/** Display-safe single-row text: a model string and a session's title are not the theme's. */
export function displayText(text: string): string {
  return oneLine(sanitizeText(text));
}

/** One row per base, retaining first-seen order and the current session's original id. */
function modelEntries(input: PickerModelInput): readonly PickerEntry[] {
  const choices = new Map<string, string>();
  const currentBase = parseModelSpec(input.currentModel).model;
  for (const original of input.models) {
    const base = parseModelSpec(original).model;
    if (!choices.has(base)) choices.set(base, original);
  }
  return Array.from(choices, ([base, first]) => {
    const current = base === currentBase;
    const original = current ? input.currentModel : first;
    const effortLabel = input.pending?.get(base) ?? parseModelSpec(original).effort ?? "default";
    return {
      value: base,
      label: displayText(base),
      original,
      effortLabel,
      detail: displayText(`effort ${effortLabel}`),
      current,
    };
  });
}

/** Shared by rendering and queued input: both resolve the same case-insensitive matches. */
export function matchingEntries(entries: readonly PickerEntry[], query: string): readonly PickerEntry[] {
  const needle = query.toLowerCase();
  return entries.filter((entry) => entry.value.toLowerCase().includes(needle));
}

/** The mode rows: what each mode does, the session's own marked. */
function modeEntries(input: PickerModelInput): readonly PickerEntry[] {
  return MODE_CHOICES.map((choice) => ({
    value: choice.mode,
    label: choice.mode,
    detail: choice.detail,
    current: choice.mode === input.currentMode,
  }));
}

/** One saved session: its title (or the id that stands in for one), its age and its holder. */
function sessionEntry(row: ChatSessionRow, nowMs: number): PickerEntry {
  const title = sessionTitleText(row.title, row.sessionId);
  const updated = relativeTime(row.updatedAt, nowMs);
  return {
    value: row.sessionId,
    label: displayText(title),
    ...(updated === "" ? {} : { detail: updated }),
    ...(row.heldByPid === undefined ? {} : { heldPid: row.heldByPid }),
  };
}

/**
 * The row a resume list draws under its entries, when it has one: what a choice warned
 * about outranks the state of the list, because a warning is a consequence of what the user
 * just did. A list still loading says so, and an empty one is not an error.
 */
function resumeNote(input: PickerModelInput): PickerNote | undefined {
  if (input.warning !== undefined) return { text: input.warning, tone: "warning" };
  if (input.sessions === undefined) return { text: LOADING, tone: "muted" };
  return input.sessions.length === 0 ? { text: NO_SESSIONS, tone: "muted" } : undefined;
}

/** The rows one kind of picker offers. */
export function pickerModel(input: PickerModelInput): PickerModel {
  if (input.kind === "mode") return { kind: "mode", title: TITLES.mode, entries: modeEntries(input) };
  if (input.kind === "effort") {
    const current = modelEffort(input.currentModel);
    return {
      kind: "effort",
      title: TITLES.effort,
      entries: (input.effortLevels ?? EFFORT_LEVELS).map((level) => ({
        value: level,
        label: level,
        current: level === current,
      })),
    };
  }
  if (input.kind === "model") {
    const allEntries = modelEntries(input);
    const entries = matchingEntries(allEntries, input.query ?? "");
    return {
      kind: "model",
      title: TITLES.model,
      entries,
      allEntries,
      query: input.query ?? "",
      ...(entries.length === 0 ? { note: { text: "no models match", tone: "muted" as const } } : {}),
    };
  }
  const nowMs = input.nowMs ?? _pickerDeps.now();
  const sessions = input.sessions ?? [];
  const note = resumeNote(input);
  return {
    kind: "resume",
    title: TITLES.resume,
    entries: sessions.map((row) => sessionEntry(row, nowMs)),
    ...(note === undefined ? {} : { note }),
  };
}
