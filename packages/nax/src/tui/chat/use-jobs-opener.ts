/**
 * The jobs picker's two gestures that need no slash command: ctrl+g and a left click on the
 * footer's job and task strip. Both open the same picker as `/jobs`, and both work while a turn
 * runs, because a slash command typed mid-turn only prints the busy notice. An ask card, an
 * open picker or a shown slash menu owns the screen, so both gestures are ignored then.
 */

import { useInput } from "ink";
import { useEffect, useRef } from "react";
import type { ChatHost } from "@/chat";
import type { MouseEvents } from "./mouse-input";
import type { PickerKind } from "./slash-commands";
import type { StyledLine } from "./styled-line";
import { spansWidth } from "./wrap";

/** Keep Ink below its full-terminal clear threshold: the frame is this many rows short of the terminal. */
export const FRAME_SLACK_ROWS = 1;
/** ink reports ctrl+g as the letter `g` with the ctrl modifier. ctrl+j arrives as a line feed, so it is not used. */
export const JOBS_KEY = "g";
const JOBS_UNAVAILABLE = "jobs are not available in this session";

export interface FooterStripHitInput {
  /** The click's 1-based column. */
  readonly x: number;
  /** The click's 1-based row. */
  readonly y: number;
  /** The footer's 1-based row. */
  readonly footerRow: number;
  readonly columns: number;
  /** Display width of the footer's right line, which is drawn flush right. */
  readonly rightWidth: number;
  /** Display width of the strip at the start of the right line; 0 when none is drawn. */
  readonly stripWidth: number;
}

/** True when the cell is on the footer row inside the strip's columns. */
export function footerStripHit({ x, y, footerRow, columns, rightWidth, stripWidth }: FooterStripHitInput): boolean {
  if (stripWidth <= 0 || y !== footerRow) return false;
  const first = columns - rightWidth + 1;
  return x >= first && x <= first + stripWidth - 1;
}

export interface JobsOpenerInput {
  readonly host: ChatHost;
  readonly mouse?: MouseEvents;
  /** An ask card, a picker or the slash menu is shown. */
  readonly blocked: boolean;
  readonly footer: { readonly right: StyledLine; readonly stripWidth: number };
  readonly size: { readonly columns: number; readonly rows: number };
  open(kind: PickerKind): void;
  note(text: string): void;
}

/** One cell of a left-button press. */
interface Press {
  readonly x: number;
  readonly y: number;
}

/** Open the jobs picker from ctrl+g or a press and release on one cell of the footer strip. */
export function useJobsOpener(input: JobsOpenerInput): void {
  // Read at event time: batched keys and mouse reports can precede the render that follows them.
  const latest = useRef(input);
  latest.current = input;
  const press = useRef<Press | undefined>(undefined);

  useInput((key, modifiers) => {
    if (!modifiers.ctrl || key !== JOBS_KEY) return;
    const { blocked, host, open, note } = latest.current;
    if (blocked) return;
    if (host.jobs === undefined && host.tasks === undefined) {
      note(JOBS_UNAVAILABLE);
      return;
    }
    latest.current = { ...latest.current, blocked: true };
    open("jobs");
  });

  const { mouse } = input;
  useEffect(() => {
    if (!mouse) return;
    return mouse.subscribe((event) => {
      if (event.button !== "left") return;
      if (event.kind === "press") {
        press.current = { x: event.x, y: event.y };
        return;
      }
      if (event.kind !== "release") return;
      const pressed = press.current;
      press.current = undefined;
      if (pressed === undefined || pressed.x !== event.x || pressed.y !== event.y) return;
      const { blocked, footer, size, open } = latest.current;
      if (blocked) return;
      const hit = footerStripHit({
        x: event.x,
        y: event.y,
        footerRow: size.rows - FRAME_SLACK_ROWS,
        columns: size.columns,
        rightWidth: spansWidth(footer.right),
        stripWidth: footer.stripWidth,
      });
      if (!hit) return;
      latest.current = { ...latest.current, blocked: true };
      open("jobs");
    });
  }, [mouse]);
}
