/**
 * The footer as role-tagged segments (US-001): what the screen shows on its left and right,
 * in pieces a fitter can drop one role at a time. A segment's text never carries the
 * separator between parts — whoever draws the side joins the texts with ` · ` — so a fitter
 * never has to recover a part's boundaries from display text.
 *
 * Split from `chat-status.ts`, which is at the source line cap and keeps the legacy span
 * producers this module reuses: `modeSpan`, `sandboxSpan`, `costSpan`, `hintSpans`,
 * `formatJobStrip`, `shortModel` and `singleRow`.
 */
import {
  costSpan,
  type FooterHint,
  type footerModel,
  formatJobStrip,
  GLYPHS,
  hintSpans,
  modeSpan,
  sandboxSpan,
  shortModel,
  singleRow,
} from "./chat-status";
import { contextSpan } from "./context-span";
import type { Span } from "./styled-line";
import type { ChatGlyphs } from "./theme";

/** What a segment is, for a fitter that drops one kind at a time. */
export type FooterRole = "mode" | "gesture" | "gestureExtra" | "sandbox" | "strip" | "model" | "context" | "cost";

/** One piece of one footer side, tagged with why it is there. */
export interface FooterSegment {
  readonly role: FooterRole;
  readonly span: Span;
}

/** The separator between two parts of a side; no segment's own text carries it. */
const SEPARATOR = " · ";

/** The footer's input, taken from `footerModel` so the two can never disagree about it. */
type FooterInput = Parameters<typeof footerModel>[0];

/** The legacy producers draw a leading separator; a segment carries its text alone. */
function unseparated(span: Span): Span {
  return span.text.startsWith(SEPARATOR) ? { ...span, text: span.text.slice(SEPARATOR.length) } : span;
}

/** A role's segment for one producer's span, or none when the producer draws nothing. */
function segmentOf(role: FooterRole, span: Span | undefined): readonly FooterSegment[] {
  return span === undefined ? [] : [{ role, span: unseparated(span) }];
}

/**
 * The gesture the hint offers, then — where the hint names a second keybinding — the extra a
 * fitter drops first. A pending quit stands alone, as it does in the unfitted footer.
 */
function hintSegments(hint: FooterHint, copiedChars: number, layerHint: string): readonly FooterSegment[] {
  const { gesture, extra } = hintSpans(hint, copiedChars, layerHint);
  const gestureSegment: FooterSegment = { role: "gesture", span: gesture };
  return extra === undefined ? [gestureSegment] : [gestureSegment, { role: "gestureExtra", span: extra }];
}

function leftSegments(input: FooterInput, glyphs: ChatGlyphs): readonly FooterSegment[] {
  const hint = hintSegments(input.hint, input.copiedChars ?? 0, input.layerHint ?? "");
  if (input.hint === "quit") return hint;
  return [
    { role: "mode", span: modeSpan(input.state, glyphs) },
    ...hint,
    ...segmentOf("sandbox", sandboxSpan(input.state.sandbox)),
  ];
}

function rightSegments(input: FooterInput): readonly FooterSegment[] {
  const strip = formatJobStrip(input.jobs ?? [], input.tasks ?? []);
  const stripSegments: readonly FooterSegment[] = strip === "" ? [] : [{ role: "strip", span: { text: strip } }];
  return [
    ...stripSegments,
    { role: "model", span: { text: shortModel(singleRow(input.state.model)) } },
    ...segmentOf("context", contextSpan(input.state, input.status)),
    { role: "cost", span: unseparated(costSpan(input.state)) },
  ];
}

/**
 * The footer's left and right sides as role-tagged segments. `footerModel`'s `right` plain text
 * is these right texts joined with the separator; its `left` is composed separately, because the
 * idle `/ commands` gesture exists only in the fitted footer.
 */
export function footerSegments(input: Parameters<typeof footerModel>[0]): {
  left: readonly FooterSegment[];
  right: readonly FooterSegment[];
} {
  return { left: leftSegments(input, input.glyphs ?? GLYPHS), right: rightSegments(input) };
}
