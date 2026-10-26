/**
 * The bottom region's arithmetic — which surface claims it, whether the transcript still
 * owns its scrolling keys, and how many rows the claimant takes.
 *
 * The screen draws exactly one of three things under the transcript: an ask card, a picker,
 * or the input with the slash menu beneath it. The order is a rule, not an accident of the
 * markup — a pending ask outranks a picker, because the card is asking a question that has to
 * be answered before anything else, and a picker outranks the input, because it replaced it.
 * The same order decides which rows are measured: only the surface actually drawn contributes
 * height, so a picker never shortens the viewport on behalf of a card that is not shown.
 *
 * The predicates are here rather than in `ChatApp.tsx` because they are read from three
 * places in its render — the slash menu's suppression, the viewport's `active` prop and the
 * bottom region's height — and a rule stated three times is a rule that will disagree with
 * itself. Nothing here draws: it returns booleans and row counts.
 */
import type { ChatPendingAsk } from "@/chat";
import { type PickerModel, pickerRows } from "./Picker";

/**
 * True while a surface other than the input owns the bottom region. Either of them hides the
 * slash menu and takes the keys the menu would have owned; the ask card's keys win when both
 * are present, which is why the card is asked about first.
 */
export function bottomBlocked(ask: ChatPendingAsk | undefined, picker: PickerModel | undefined): boolean {
  return ask !== undefined || picker !== undefined;
}

/** True while the transcript still owns its scrolling keys: nothing locked, no picker shown. */
export function viewportActive(locked: boolean, picker: PickerModel | undefined): boolean {
  return !locked && picker === undefined;
}

/**
 * The rows the bottom region claims: the ask card's, the picker's frame and entries, or the
 * input and the menu under it. The first two are clamped to the budget the screen can spare;
 * the input is not, because its own rows are already capped by that same budget.
 */
export function bottomRowsFor(input: {
  /** The rows the ask card draws, or undefined when no card is shown. */
  readonly ask: number | undefined;
  readonly picker: PickerModel | undefined;
  /** The rows the input and its menu draw. */
  readonly input: number;
  readonly budget: number;
}): number {
  if (input.ask !== undefined) return Math.min(input.ask, input.budget);
  if (input.picker !== undefined) return Math.min(pickerRows(input.picker, input.budget), input.budget);
  return input.input;
}
