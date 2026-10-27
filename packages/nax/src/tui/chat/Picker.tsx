/**
 * Picker — the framed list the chat screen shows in place of its input while a slash
 * command's argument can only be chosen (US-027).
 *
 * `/model`, `/resume` and `/mode` with no argument answer with a `picker` outcome rather
 * than sending anything (`slash-commands.ts`), and this module is what the screen does with
 * it. One model, three lists: the host's models with the session's own marked `(current)`,
 * the two permission modes with the statement each one makes, and — US-027's second half —
 * the saved sessions.
 *
 * The pure half is the list: `pickerModel` builds the rows a picker draws and `pickerLayout`
 * turns them into styled lines, windowed to `PICKER_MAX_ROWS` around the pointer and never
 * taller than the rows the screen can spare. `pickerRows` is the same arithmetic without a
 * theme, because the screen measures the rows it reserves before it draws them — the entry
 * window is capped by that budget, so the footer stays on the screen's last row however many
 * models a catalogue holds.
 *
 * The hook is the state: which picker is open and what it is waiting on, so the screen owns
 * no part of a list it merely mounts. Every choice runs through `useChatKeys.runControl`,
 * which is what makes a rejected `switchTo` or `resume` an error entry in the transcript
 * rather than an unhandled rejection, and what keeps two host actions from overlapping. The
 * picker closes on the choice — a list that has answered has nothing left to say — so the
 * input returns whether the host accepted the choice or not.
 *
 * Keys have one owner here: escape (cancel), return (choose) and the unmodified up / down
 * (move). A shifted or chorded key belongs to another surface — shift+tab cycles the mode,
 * ctrl+o toggles collapsed detail, ctrl-c quits — and pageUp / pageDown / home / end stay
 * with the transcript viewport, which the screen renders inactive while a picker is shown.
 * The pointer is kept in a ref as well as in the state because two keys delivered in one
 * batch both run before the re-render that would show the first one's move, and a return in
 * that batch would otherwise choose the row the picker no longer shows.
 */
import { Box, type Key, useInput } from "ink";
import { type ReactElement, useCallback, useRef, useState } from "react";
import type { ChatHost, ChatHostState, ChatMode, ChatSessionRow } from "@/chat";
import { oneLine, resolveWidth, SPACE, styled } from "./layout-lines";
import { relativeTime } from "./relative-time";
import type { PickerKind } from "./slash-commands";
import { displayWidth, type Span, type StyledLine, StyledLineView, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";
import { cutSpans } from "./wrap";

/** The most entries the picker draws at once; past this the window follows the pointer. */
export const PICKER_MAX_ROWS = 8;

/** The rows the frame's two rules and its title claim, before any entry is drawn. */
const FRAME_ROWS = 3;

/** The first entry's index — where the pointer starts for every list. */
const FIRST_ENTRY = 0;

/** The columns between a row's label and what follows it: the pointer's own gap. */
const COLUMN_GAP = "  ";

/** The marker a list puts on the value the session is already on. */
const CURRENT_MARK = "(current)";

/** How much of a session id names a session that never got a title. */
const ID_CHARS = 8;
const UNTITLED = "untitled";

/** The two notes a resume list draws in place of rows it does not have yet. */
const LOADING = "loading…";
const NO_SESSIONS = "no saved sessions";

/** The title each kind of picker draws, in the words the design fixes. */
const TITLES = {
  model: "Switch model",
  resume: "Resume a session",
  mode: "Permission mode",
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
  /** The choice the host action takes: a model string, a permission mode, a session id. */
  readonly value: string;
  readonly label: string;
  /** The muted column after the label: what a mode does, or how old a session is. */
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
function displayText(text: string): string {
  return oneLine(sanitizeText(text));
}

/** The model rows: one per catalogue entry, the session's own marked. */
function modelEntries(input: PickerModelInput): readonly PickerEntry[] {
  return input.models.map((model) => ({
    value: model,
    label: displayText(model),
    current: model === input.currentModel,
  }));
}

/** Shared by rendering and queued input: both resolve the same case-insensitive matches. */
function matchingEntries(entries: readonly PickerEntry[], query: string): readonly PickerEntry[] {
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
  const title = row.title === null ? `${UNTITLED} ${row.sessionId.slice(0, ID_CHARS)}` : row.title;
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

/** The permission mode a row names; `guarded` is the default for anything the list does not. */
function pickerMode(value: string): ChatMode {
  return value === "full" ? "full" : "guarded";
}

export interface PickerLayoutOptions {
  /** The columns the picker is drawn into. */
  readonly width: number;
  readonly theme: ChatTheme;
  /** The rows the screen can give the picker; the entry window never exceeds them. */
  readonly budget: number;
  /** The entry the pointer is on, as the picker tracked it; clamped to the entries it has. */
  readonly selected?: number;
}

/** The rows the picker draws, already windowed around the pointer. */
export interface PickerLayout {
  /** The pointer's row, clamped to the entries. */
  readonly selected: number;
  /** The index of the first entry drawn. */
  readonly first: number;
  /** Every row the picker occupies — `lines.length`. */
  readonly rows: number;
  readonly lines: readonly StyledLine[];
}

/** The rows a picker's frame and title claim, plus the note row when it has one. */
function fixedRows(model: PickerModel): number {
  return FRAME_ROWS + (model.kind === "model" ? 1 : 0) + (model.note === undefined ? 0 : 1);
}

/** How many entries the picker draws: the window's rows, never past the rows it was given. */
function visibleEntries(model: PickerModel, budget: number): number {
  return Math.min(model.entries.length, PICKER_MAX_ROWS, Math.max(0, budget - fixedRows(model)));
}

/** The index of the first entry drawn, so the window always holds the pointer. */
function windowStart(count: number, selected: number, rows: number): number {
  return Math.max(FIRST_ENTRY, Math.min(selected - rows + 1, count - rows));
}

/** The frame's rule: the theme's rule glyph across the picker, in the border tone. */
function ruleRow(theme: ChatTheme, columns: number): StyledLine {
  return [styled(theme.glyphs.rule.repeat(columns), { color: "border" })];
}

/** The pointer on the chosen row, and the blank that holds an unselected label in its column. */
function pointerPrefix(theme: ChatTheme, chosen: boolean): Span {
  const pointer = theme.glyphs.pointer;
  if (!chosen) return styled(SPACE.repeat(displayWidth(pointer) + SPACE.length));
  return styled(`${pointer}${SPACE}`, { color: "accent" });
}

/** The columns that say another process holds a session. */
function heldLabel(pid: number): string {
  return `in use (pid ${pid})`;
}

/** One entry: the pointer, its label, then the detail, the marker and its holder's column. */
function entryRow(entry: PickerEntry, chosen: boolean, theme: ChatTheme, columns: number): StyledLine {
  const spans: Span[] = [pointerPrefix(theme, chosen), styled(entry.label, chosen ? { bold: true } : {})];
  if (entry.detail !== undefined) spans.push(styled(`${COLUMN_GAP}${entry.detail}`, { color: "muted" }));
  if (entry.current === true) spans.push(styled(`${COLUMN_GAP}${CURRENT_MARK}`, { color: "accent" }));
  if (entry.heldPid !== undefined) {
    spans.push(styled(`${COLUMN_GAP}${heldLabel(entry.heldPid)}`, { color: "warning" }));
  }
  return cutSpans(spans, columns);
}

/** The picker's one note row: muted while it only reports, warning-toned when it warns. */
function noteRow(note: PickerNote, theme: ChatTheme, columns: number): StyledLine {
  const text = displayText(note.text);
  const spans: Span[] =
    note.tone === "warning"
      ? [styled(`${theme.glyphs.warning}${SPACE}`, { color: "warning" }), styled(text, { color: "warning" })]
      : [styled(text, { color: "muted" })];
  return cutSpans(spans, columns);
}

/** The rows the picker occupies for a budget: its frame, title, window and note, and no more. */
export function pickerRows(model: PickerModel, budget: number): number {
  return fixedRows(model) + visibleEntries(model, Math.max(1, Math.floor(budget)));
}

/** The rows the picker draws at a given width and budget, windowed around the pointer. */
export function pickerLayout(model: PickerModel, options: PickerLayoutOptions): PickerLayout {
  const columns = resolveWidth(options.width);
  const budget = Math.max(1, Math.floor(options.budget));
  const rows = visibleEntries(model, budget);
  const last = Math.max(FIRST_ENTRY, model.entries.length - 1);
  const selected = Math.min(Math.max(options.selected ?? FIRST_ENTRY, FIRST_ENTRY), last);
  const first = windowStart(model.entries.length, selected, rows);
  const lines: StyledLine[] = [
    ruleRow(options.theme, columns),
    cutSpans([styled(displayText(model.title), { bold: true })], columns),
    ...(model.kind === "model"
      ? [
          cutSpans(
            [styled(model.query ? `Filter: ${displayText(model.query)}` : "type to filter", { color: "muted" })],
            columns,
          ),
        ]
      : []),
    ...model.entries
      .slice(first, first + rows)
      .map((entry, at) => entryRow(entry, first + at === selected, options.theme, columns)),
    ...(model.note === undefined ? [] : [noteRow(model.note, options.theme, columns)]),
    ruleRow(options.theme, columns),
  ];
  return { selected, first, rows: lines.length, lines };
}

interface PickerState {
  readonly kind: PickerKind;
  readonly query: string;
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
}

/** The host action a choice names, decided by which picker asked. */
function actionFor(host: ChatHost, kind: PickerKind, entry: PickerEntry): Promise<void> {
  if (kind === "model") return host.switchTo({ model: entry.value });
  if (kind === "mode") return host.switchTo({ mode: pickerMode(entry.value) });
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

  const cancel = useCallback((): void => {
    openings.current += 1;
    setState(undefined);
  }, []);

  const open = useCallback(
    (kind: PickerKind): void => {
      openings.current += 1;
      const opening = openings.current;
      setState({ kind, query: "" });
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
      void runControl(() => actionFor(host, kind, entry));
    },
    [state, host, runControl],
  );

  const current = state === undefined ? undefined : host.current();
  const model = state === undefined || current === undefined ? undefined : modelOf(state, current, host.models);
  const setQuery = useCallback((query: string): void => {
    setState((current) => (current?.kind === "model" ? { ...current, query } : current));
  }, []);
  return { model, open, cancel, choose, setQuery };
}

/** The keys the picker owns, and no others. */
function ownsPickerKey(key: Key): boolean {
  return Boolean(key.escape || key.return || key.upArrow || key.downArrow);
}

/** Where the pointer is, and which list it was placed in. */
interface PickerSelection {
  readonly kind: PickerKind;
  readonly query?: string;
  readonly index: number;
}

export interface PickerProps {
  readonly model: PickerModel;
  readonly query?: string;
  readonly onQuery?: (query: string) => void;
  readonly width: number;
  readonly theme: ChatTheme;
  /** The rows the screen can give the picker; the entry window never exceeds them. */
  readonly budget: number;
  /** False while another surface — an ask card — owns the keys. */
  readonly active?: boolean;
  readonly onChoose: (entry: PickerEntry) => void;
  readonly onCancel: () => void;
}

/** Query deletion follows the same whole-grapheme convention as the chat editor. */
const QUERY_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Model-only editing; chords and navigation stay with their existing owners. */
function editedQuery(input: string, key: Key, query: string): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  if (key.backspace || key.delete) {
    const graphemes = Array.from(QUERY_SEGMENTER.segment(query), (part) => part.segment);
    return graphemes.slice(0, -1).join("");
  }
  if (
    input !== "" &&
    !key.return &&
    !key.upArrow &&
    !key.downArrow &&
    Array.from(input).every((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
  )
    return query + input;
  return undefined;
}

export function Picker({
  model,
  width,
  theme,
  budget,
  active = true,
  onChoose,
  onCancel,
  query = model.query ?? "",
  onQuery,
}: PickerProps): ReactElement {
  const [selection, setSelection] = useState<PickerSelection>({ kind: model.kind, index: FIRST_ENTRY });
  /** The newest pointer, ahead of the re-render two keys in one batch would share. */
  const latest = useRef<PickerSelection>(selection);
  if (latest.current.kind !== model.kind || latest.current.query !== query) {
    latest.current = { kind: model.kind, query, index: FIRST_ENTRY };
  }
  const queryRef = useRef(query);
  queryRef.current = query;
  /** Resolve against the synchronous query, not the previous render's filtered rows. */
  const entries = (): readonly PickerEntry[] =>
    model.kind === "model" ? matchingEntries(model.allEntries ?? model.entries, queryRef.current) : model.entries;
  const last = (): number => Math.max(FIRST_ENTRY, entries().length - 1);
  /** The newest pointer, clamped to the latest query's matches even within one input batch. */
  const pointer = (): number => Math.min(Math.max(latest.current.index, FIRST_ENTRY), last());

  const move = (delta: number): void => {
    const value: PickerSelection = {
      kind: model.kind,
      query: queryRef.current,
      index: Math.min(Math.max(pointer() + delta, FIRST_ENTRY), last()),
    };
    latest.current = value;
    setSelection(value);
  };

  /** Returns true when model-query editing consumed the key, including empty deletion. */
  const editQuery = (input: string, key: Key): boolean => {
    if (model.kind !== "model" || key.escape) return false;
    const next = editedQuery(input, key, queryRef.current);
    if (next === undefined) return false;
    if (next === queryRef.current) return true;
    queryRef.current = next;
    onQuery?.(next);
    const reset = { kind: model.kind, query: next, index: FIRST_ENTRY };
    latest.current = reset;
    setSelection(reset);
    return true;
  };

  useInput(
    (input, key) => {
      if (editQuery(input, key)) return;
      if (!ownsPickerKey(key)) return;
      // ink reports a lone escape as `escape` *and* `meta`, so escape is taken first: the
      // chord rule below is about shifted and ctrl keys, which belong to other surfaces.
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.shift || key.ctrl || key.meta) return;
      const entry = entries()[pointer()];
      if (entry === undefined) return;
      if (key.return) onChoose(entry);
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
    },
    { isActive: active },
  );

  const layout = pickerLayout(model, { width, theme, budget, selected: pointer() });
  return (
    <Box flexDirection="column">
      {layout.lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the picker's rows are positional and redrawn whole as the window moves.
        <StyledLineView key={index} line={line} theme={theme} />
      ))}
    </Box>
  );
}
