/**
 * Renders a three-row frame into a six-row fake TTY with incremental rendering, repaints it
 * without changing the component, unmounts it and repaints once more, then prints every
 * write Ink made as JSON on stdout. Run as its own process: Ink decides whether it is
 * interactive (`is-in-ci`) when it is first imported. Plain JavaScript, so the TTY-shaped
 * double needs no cast to Ink's stream type.
 */
import { EventEmitter } from "node:events";
import { Box, render, Text } from "ink";
import { createElement } from "react";

const ROWS = 6;
const COLUMNS = 20;
const SETTLE_MS = 80;
/** The three rows the repaint must write again, unchanged. */
const ROWS_TEXT = ["alpha", "bravo", "charlie"];
const writes = [];
const stdout = Object.assign(new EventEmitter(), {
  isTTY: true,
  columns: COLUMNS,
  rows: ROWS,
  write: (chunk) => {
    writes.push(chunk);
    return true;
  },
});

function frame() {
  return createElement(
    Box,
    { flexDirection: "column", height: ROWS - 1 },
    ...ROWS_TEXT.map((text) => createElement(Text, { key: text }, text)),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const instance = render(frame(), { stdout, incrementalRendering: true, patchConsole: false });
await settle();
const first = writes.slice(0);
instance.repaint();
await settle();
const repaint = writes.slice(first.length);
instance.unmount();
await settle();
const unmount = writes.slice(first.length + repaint.length);
const beforeSecondRepaint = writes.length;
instance.repaint();
await settle();
const afterUnmount = writes.slice(beforeSecondRepaint);
process.stdout.write(JSON.stringify({ first, repaint, unmount, afterUnmount }));
process.exit(0);
