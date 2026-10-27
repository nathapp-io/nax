import { useEffect, useRef, useState } from "react";
import type { MouseEvents } from "./mouse-input";
import { type Selection, selectedText, transcriptPointAt, type ViewportGeometry } from "./selection";
import type { StyledLine } from "./styled-line";

interface MouseSelectionInput {
  readonly mouse?: MouseEvents;
  readonly active: boolean;
  readonly geometry: ViewportGeometry;
  readonly lines: readonly StyledLine[];
  readonly onCopy?: (text: string) => void;
}

interface MouseGesture {
  selection?: Selection;
  dragging: boolean;
}

/**
 * A release ends the gesture once; a click has no range to copy, and a range over blank
 * cells has no text, so neither overwrites the clipboard (#2718).
 */
function finishSelection(gesture: MouseGesture, input: MouseSelectionInput): void {
  gesture.dragging = false;
  const range = gesture.selection;
  if (!range || (range.anchor.line === range.focus.line && range.anchor.column === range.focus.column)) return;
  const text = selectedText(input.lines, range);
  if (text.length > 0) input.onCopy?.(text);
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
        current.selection = point ? { anchor: point, focus: point } : undefined;
        current.dragging = point !== undefined;
        setSelection(undefined); // A click alone has no visible selection.
      } else if (event.kind === "drag" && current.dragging && current.selection && point) {
        current.selection = { ...current.selection, focus: point };
        setSelection(current.selection);
      } else if (event.kind === "release" && current.dragging) {
        finishSelection(current, latest.current);
      }
    });
  }, [input.active, input.mouse]);
  return selection;
}
