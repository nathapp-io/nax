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

/** Gesture state is synchronous so batched mouse reports never read a stale focus. */
export function useMouseSelection(input: MouseSelectionInput): Selection | undefined {
  const latest = useRef(input);
  latest.current = input;
  const gesture = useRef<{ selection?: Selection; dragging: boolean }>({ dragging: false });
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
      const { geometry, lines, onCopy } = latest.current;
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
        current.dragging = false;
        const range = current.selection;
        if (range && (range.anchor.line !== range.focus.line || range.anchor.column !== range.focus.column)) {
          onCopy?.(selectedText(lines, range));
        }
      }
    });
  }, [input.active, input.mouse]);
  return selection;
}
