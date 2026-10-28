import { useEffect, useRef, useState } from "react";
import type { MouseEvent, MouseEvents } from "./mouse-input";
import {
  type Selection,
  selectedText,
  type TranscriptPoint,
  transcriptPointAt,
  type ViewportGeometry,
} from "./selection";
import type { StyledLine } from "./styled-line";

interface MouseSelectionInput {
  readonly mouse?: MouseEvents;
  readonly active: boolean;
  readonly geometry: ViewportGeometry;
  readonly lines: readonly StyledLine[];
  readonly onCopy?: (text: string) => void;
  readonly onClick?: (point: TranscriptPoint) => void;
}

interface MouseGesture {
  selection?: Selection;
  dragging: boolean;
  press?: { readonly x: number; readonly y: number };
  moved?: boolean;
}

/**
 * A release ends the gesture once; a click has no range to copy, and a range over blank
 * cells has no text, so neither overwrites the clipboard (#2718).
 */
function finishSelection(gesture: MouseGesture, input: MouseSelectionInput, sameCell: boolean): void {
  gesture.dragging = false;
  const range = gesture.selection;
  if (!range) return;
  if (range.anchor.line === range.focus.line && range.anchor.column === range.focus.column) {
    if (!gesture.moved && sameCell) input.onClick?.(range.anchor);
    return;
  }
  const text = selectedText(input.lines, range);
  if (text.length > 0) input.onCopy?.(text);
}

function atPressCell(gesture: MouseGesture, event: MouseEvent): boolean {
  return event.x === gesture.press?.x && event.y === gesture.press?.y;
}

function startSelection(gesture: MouseGesture, event: MouseEvent, point: TranscriptPoint | undefined): void {
  gesture.selection = point ? { anchor: point, focus: point } : undefined;
  gesture.dragging = point !== undefined;
  gesture.press = { x: event.x, y: event.y };
  gesture.moved = false;
}

/** Track every excursion, but retain the last mapped focus when dragging outside. */
function moveSelection(
  gesture: MouseGesture,
  event: MouseEvent,
  point: TranscriptPoint | undefined,
): Selection | undefined {
  if (!gesture.dragging || !gesture.selection) return undefined;
  if (!atPressCell(gesture, event)) gesture.moved = true;
  if (!point) return undefined;
  gesture.selection = { ...gesture.selection, focus: point };
  return gesture.selection;
}

/** Gesture state is synchronous so batched mouse reports never read a stale focus. */
export function useMouseSelection(input: MouseSelectionInput): Selection | undefined {
  const latest = useRef(input);
  latest.current = input;
  const gesture = useRef<MouseGesture>({ dragging: false });
  const [selection, setSelection] = useState<Selection>();
  const [total, setTotal] = useState(input.lines.length);
  if (total !== input.lines.length) {
    setTotal(input.lines.length);
    gesture.current = { dragging: false };
    setSelection(undefined);
  }
  useEffect(() => {
    if (!input.active || !input.mouse) return;
    return input.mouse.subscribe((event) => {
      if (event.button !== "left") return;
      const { geometry } = latest.current;
      const point = transcriptPointAt(geometry, event.x, event.y);
      const current = gesture.current;
      if (event.kind === "press") {
        startSelection(current, event, point);
        setSelection(undefined); // A click alone has no visible selection.
      } else if (event.kind === "drag") {
        const moved = moveSelection(current, event, point);
        if (moved) setSelection(moved);
      } else if (event.kind === "release" && current.dragging) {
        finishSelection(current, latest.current, atPressCell(current, event));
      }
    });
  }, [input.active, input.mouse]);
  return selection;
}
