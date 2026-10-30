/**
 * Picker — the framed list the chat screen shows in place of its input while a slash
 * command's argument can only be chosen (US-027).
 *
 * `/model`, `/resume`, `/mode` and `/effort` without arguments answer with a `picker` outcome
 * rather than sending anything (`slash-commands.ts`). The screen draws the host's models,
 * the two permission modes, the saved sessions, or the eight reasoning effort levels.
 * Model, mode and effort lists mark the session's own choice `(current)`.
 *
 * The pure half is the list: `pickerModel` builds the rows a picker draws and `pickerLayout`
 * turns them into styled lines, windowed to `PICKER_MAX_ROWS` around the pointer and never
 * taller than the rows the screen can spare. `pickerRows` is the same arithmetic without a
 * theme, because the screen measures the rows it reserves before it draws them — the entry
 * window is capped by that budget, so the footer stays on the screen's last row however many
 * models a catalogue holds.
 *
 * `useChatPicker.ts` owns the state: which picker is open and what it is waiting on, so the screen owns
 * no part of a list it merely mounts. Every choice runs through `useChatKeys.runControl`,
 * which is what makes a rejected `switchTo` or `resume` an error entry in the transcript
 * rather than an unhandled rejection, and what keeps two host actions from overlapping. The
 * picker closes on the choice — a list that has answered has nothing left to say — so the
 * input returns whether the host accepted the choice or not.
 *
 * Keys have one owner here: escape (cancel), return (choose) and the unmodified up / down
 * (move), plus left / right for model effort only. A shifted or chorded key belongs to another
 * surface — shift+tab cycles the mode,
 * ctrl+o toggles collapsed detail, ctrl-c quits — and pageUp / pageDown / home / end stay
 * with the transcript viewport, which the screen renders inactive while a picker is shown.
 * The pointer is kept in a ref as well as in the state because two keys delivered in one
 * batch both run before the re-render that would show the first one's move, and a return in
 * that batch would otherwise choose the row the picker no longer shows.
 */
import { Box, type Key, useInput } from "ink";
import { type ReactElement, useRef, useState } from "react";
import { resolveWidth, SPACE, styled } from "./layout-lines";
import { displayText, matchingEntries, type PickerEntry, type PickerModel, type PickerNote } from "./picker-model";
import type { PickerKind } from "./slash-commands";
import { displayWidth, type Span, type StyledLine, StyledLineView } from "./styled-line";
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

export {
  _pickerDeps,
  type PickerEntry,
  type PickerModel,
  type PickerModelInput,
  type PickerNote,
  pickerModel,
} from "./picker-model";
export { type ChatPicker, type ChatPickerOptions, useChatPicker } from "./useChatPicker";

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

/** ctrl+x: the jobs picker's stop key. */
function isStopKey(input: string, key: Key, kind: PickerKind): boolean {
  return kind === "jobs" && key.ctrl && input === "x";
}

/** The keys the picker owns, and no others. */
function ownsPickerKey(input: string, key: Key, kind: PickerKind): boolean {
  return Boolean(
    key.escape ||
      key.return ||
      key.upArrow ||
      key.downArrow ||
      (kind === "model" && (key.leftArrow || key.rightArrow)) ||
      isStopKey(input, key, kind),
  );
}

/** Where the pointer is, and which list it was placed in. */
interface PickerSelection {
  readonly kind: PickerKind;
  readonly query?: string;
  readonly index: number;
  /** The jobs picker's highlight: the row's value, so it follows the row as the list regroups. */
  readonly value?: string;
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
  readonly onCycle?: (entry: PickerEntry, step: 1 | -1) => void;
  /** ctrl+x on the jobs picker's highlighted entry. */
  readonly onStop?: (entry: PickerEntry) => void;
  readonly onCancel: () => void;
}

interface PickerEntryActions extends Pick<PickerProps, "onChoose" | "onCycle"> {
  move(delta: number): void;
}

/** Dispatch an owned, unmodified key after resolving the latest highlighted entry. */
function applyEntryKey(key: Key, entry: PickerEntry, actions: PickerEntryActions): void {
  if (key.return) actions.onChoose(entry);
  else if (key.upArrow) actions.move(-1);
  else if (key.downArrow) actions.move(1);
  else if (key.leftArrow) actions.onCycle?.(entry, -1);
  else if (key.rightArrow) actions.onCycle?.(entry, 1);
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
    !key.leftArrow &&
    !key.rightArrow &&
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
  onCycle,
  onStop,
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
  // The jobs list regroups as rows change state: the highlight is the row's value, and falls
  // back to the first row only when that row is no longer listed (or nothing was chosen yet).
  if (model.kind === "jobs" && !model.entries.some((entry) => entry.value === latest.current.value)) {
    latest.current = { ...latest.current, index: FIRST_ENTRY, value: model.entries[FIRST_ENTRY]?.value };
  }
  const queryRef = useRef(query);
  queryRef.current = query;
  /** Resolve against the synchronous query, not the previous render's filtered rows. */
  const entries = (): readonly PickerEntry[] =>
    model.kind === "model" ? matchingEntries(model.allEntries ?? model.entries, queryRef.current) : model.entries;
  const last = (): number => Math.max(FIRST_ENTRY, entries().length - 1);
  /** The newest pointer, clamped to the latest query's matches even within one input batch. */
  const pointer = (): number => {
    if (model.kind === "jobs") {
      return Math.max(
        FIRST_ENTRY,
        model.entries.findIndex((entry) => entry.value === latest.current.value),
      );
    }
    return Math.min(Math.max(latest.current.index, FIRST_ENTRY), last());
  };

  const move = (delta: number): void => {
    const index = Math.min(Math.max(pointer() + delta, FIRST_ENTRY), last());
    const value: PickerSelection = {
      kind: model.kind,
      query: queryRef.current,
      index,
      ...(model.kind === "jobs" ? { value: entries()[index]?.value } : {}),
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
      if (!ownsPickerKey(input, key, model.kind)) return;
      // ink reports a lone escape as `escape` *and* `meta`, so escape is taken first: the
      // chord rule below is about shifted and ctrl keys, which belong to other surfaces.
      if (key.escape) {
        onCancel();
        return;
      }
      const entry = entries()[pointer()];
      // ctrl+x is the one chord the jobs picker owns, so it is taken before the chord rule.
      if (isStopKey(input, key, model.kind)) {
        if (entry !== undefined) onStop?.(entry);
        return;
      }
      if (key.shift || key.ctrl || key.meta) return;
      if (entry === undefined) return;
      applyEntryKey(key, entry, { onChoose, onCycle, move });
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
