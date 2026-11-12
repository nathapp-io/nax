import { footerModel, workingLine } from "./chat-status";
import type { StyledLine } from "./styled-line";
import { cutSpans, spansWidth } from "./wrap";

const GAP = 2;
const SEPARATOR = " · ";

/** Fit before Ink lays out the row, keeping gestures ahead of duplicated model metadata. */
export function fittedFooterModel(input: Parameters<typeof footerModel>[0] & { readonly width: number }) {
  const footer = footerModel(input);
  const width = Math.max(1, Math.floor(input.width));
  const idle = input.hint === "idle";
  const left = idle
    ? footer.left.map((span) =>
        span.text === "shift+tab to cycle" ? { ...span, text: "/ commands · shift+tab to cycle" } : span,
      )
    : footer.left;
  const compact = idle
    ? left.map((span) => (span.text === "/ commands · shift+tab to cycle" ? { ...span, text: "/ commands" } : span))
    : left;
  // Strip, separator, model precede context and cost. Dropping the model keeps metering.
  const withoutModel =
    footer.stripWidth > 0
      ? [...footer.right.slice(0, 1), ...footer.right.slice(3)]
      : footer.right
          .slice(1)
          .map((span, index) => (index === 0 ? { ...span, text: span.text.replace(/^ · /, "") } : span));
  const cost = footer.right.slice(-1).map((span) => ({ ...span, text: span.text.replace(/^ · /, "") }));
  const count = (input.jobs?.length ?? 0) + (input.tasks?.length ?? 0);
  const summary = `${count} active (ctrl+g)`;
  const rights = [
    { right: footer.right, stripWidth: footer.stripWidth },
    { right: withoutModel, stripWidth: footer.stripWidth },
    ...(count === 0
      ? []
      : [{ right: [{ text: summary }, { text: SEPARATOR }, ...cost], stripWidth: spansWidth([{ text: summary }]) }]),
    { right: cost, stripWidth: 0 },
    { right: [], stripWidth: 0 },
  ];
  for (const candidate of [left, compact]) {
    for (const right of rights) {
      const gap = right.right.length === 0 ? 0 : GAP;
      if (spansWidth(candidate) + spansWidth(right.right) + gap <= width) return { left: candidate, ...right };
    }
  }
  // On very small panes show the gesture first; a sandbox warning remains ahead of mode.
  const gesture = compact.slice(2);
  const urgent: StyledLine = gesture.length === 0 ? compact : gesture;
  return { left: cutSpans(urgent, width), right: [], stripWidth: 0 };
}

/** A narrow working row keeps its phase and time; the footer carries the active escape hint. */
export function fittedWorkingLine(
  ...[status, now, glyphs, hint, width]: [...Parameters<typeof workingLine>, number]
): StyledLine | undefined {
  const line = workingLine(status, now, glyphs, hint);
  if (line === undefined || spansWidth(line) <= width) return line;
  const started = Date.parse(status.startedAt ?? "");
  const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 1000)) : 0;
  return cutSpans([...line.slice(0, -1), { text: ` (${seconds}s)`, color: "muted" }], width);
}
