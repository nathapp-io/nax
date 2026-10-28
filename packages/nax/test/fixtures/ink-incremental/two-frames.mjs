/**
 * Renders a five-row frame into a six-row fake TTY with incremental rendering, rerenders it
 * with one row changed, and prints every write Ink made as JSON on stdout. Run as its own
 * process: Ink decides whether it is interactive (`is-in-ci`) when it is first imported.
 * Plain JavaScript, so the TTY-shaped double needs no cast to Ink's stream type.
 */
import { EventEmitter } from "node:events";
import { Box, render, Text } from "ink";
import { createElement } from "react";

const ROWS = 6;
const SETTLE_MS = 80;
const writes = [];
const stdout = Object.assign(new EventEmitter(), {
  isTTY: true,
  columns: 20,
  rows: ROWS,
  write: (chunk) => {
    writes.push(chunk);
    return true;
  },
});

function frame(last) {
  const rows = ["header", "one", "two", "three", last];
  return createElement(
    Box,
    { flexDirection: "column", height: ROWS - 1 },
    ...rows.map((text) => createElement(Text, { key: text }, text)),
  );
}

const instance = render(frame("before"), { stdout, incrementalRendering: true, patchConsole: false });
const first = writes.length;
instance.rerender(frame("after"));
setTimeout(() => {
  instance.unmount();
  process.stdout.write(JSON.stringify({ first: writes.slice(0, first), redraw: writes.slice(first) }));
  process.exit(0);
}, SETTLE_MS);
