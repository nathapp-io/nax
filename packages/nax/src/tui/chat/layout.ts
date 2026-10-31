/**
 * Transcript layout — `layoutTranscript` turns the entry union into the styled lines the
 * chat view draws: each entry's own lines, with one empty line between the entries that
 * produced any.
 *
 * The columns engine every renderer shares — the width floor, the sanitised source lines,
 * the word wrap and the indent-preserving prefix — lives in `layout-lines.ts`, so a narrow
 * terminal lays a message, a card and a notice out by the same rules. The entries that
 * carry the screen's own words rather than a message live beside it: `layout-status.ts`
 * draws the welcome banner, a notice, a warning, an error and an interruption, and
 * `layout-listing.ts` draws a titled listing. This module keeps the message and tool-card
 * renderers, the dispatcher over the whole union, and the per-entry cache.
 *
 * A reply is rendered into the columns left behind its gutter, and the one line
 * `renderMarkdown` leaves wide on purpose — a fenced block's code line — is cut at the
 * layout's width (wrapping would invent line numbers the code's own indentation
 * contradicts). Every other line it leaves wide, a table's source text or raw HTML, is
 * wrapped instead, so a narrow layout never loses a reply's words.
 *
 * A tool card is drawn from `toolCardModel`: header, result summary, an Edit's diff and,
 * while collapsed, the count of the lines ctrl+o would reveal. The model reports tones, not
 * colours, so the same card draws on a truecolour, a 16-colour or a colourless terminal —
 * a diff line falls back to `danger`/`success` when the theme has no background to band it
 * with.
 *
 * One entry's lines are computed once per `(width, expanded)` pair and reused while the
 * entry object is the same one: the reducer replaces only the entries an event touched, so
 * a streaming reply re-lays out alone and the rest of a long transcript is not redrawn.
 * `_layoutDeps.layoutEntry` is the injected per-entry renderer, which is what makes that
 * observable.
 */

import { attachmentLines } from "./layout-attachment";
import {
  cardIndent,
  cardRows,
  EMPTY_LINE,
  GUTTER,
  GUTTER_WIDTH,
  HIDE_HINT,
  type LayoutContext,
  line,
  oneLine,
  prefixedLine,
  resolveWidth,
  resultPrefix,
  SHOW_HINT,
  SOURCE_LINE_BREAK,
  SPACE,
  type SpanStyle,
  styled,
  textLines,
  wrappedSource,
  wrapText,
} from "./layout-lines";
import { listingLines } from "./layout-listing";
import { userTextSpans } from "./layout-mentions";
import { interruptedLines, statusLines, welcomeLines } from "./layout-status";
import { renderMarkdown } from "./markdown";
import { MIN_LAYOUT_WIDTH, type Span, type StyledLine, sanitizeText } from "./styled-line";
import type { ChatColorToken, ChatTheme } from "./theme";
import { type CardLine, type DiffLine, secondsBetween, type ToolCardModel, toolCardModel } from "./tool-card";
import type { TranscriptEntry } from "./transcript-model";

/** An empty line, re-exported so a view can pad a short screen the way the layout separates entries. */
export { EMPTY_LINE } from "./layout-lines";
export { type ListingTone, listingTone } from "./layout-listing";

export interface LayoutOptions {
  /** The columns available to the transcript; below `MIN_LAYOUT_WIDTH` is treated as it. */
  readonly width: number;
  readonly theme: ChatTheme;
  /** Whether collapsed detail — thinking text, tool output — is shown. */
  readonly expanded: boolean;
}

type UserEntry = Extract<TranscriptEntry, { kind: "user" }>;
type ReplyEntry = Extract<TranscriptEntry, { kind: "reply" }>;
type ThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;
type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/**
 * The narrowest width a reply's markdown is rendered into. It is the layout's floor minus
 * the gutter, and is passed as `minWidth` so the renderer respects a content budget that
 * is legitimately narrower than a whole layout.
 */
const MIN_REPLY_WIDTH = MIN_LAYOUT_WIDTH - GUTTER_WIDTH;
/** The marker that opens a user message; it is its own span so a view can colour it. */
const USER_MARKER = ">";
const USER_BAND = "userBand";
const THOUGHT_FOR = "Thought for";
const SECONDS_SUFFIX = "s";
/** The colour a tool card's bullet takes, by the tone its model reported. */
const BULLET_COLORS = {
  running: "muted",
  success: "success",
  danger: "danger",
} as const satisfies Record<ToolCardModel["tone"], ChatColorToken>;
/** What a collapsed card's last line promises. */
const EXPAND_HINT = "lines (ctrl+o to expand)";
/** Opens the count of the lines a collapsed card withholds. */
const HIDDEN_LINE_MARK = "+";

/** Muted italics: how the layout draws anything the model thought rather than said. */
function thoughtLine(text: string): StyledLine {
  return line([{ text, color: "muted", italic: true }]);
}

/**
 * A user message: every source line behind the accent marker (its continuations, and
 * every later source line, behind two spaces), banded `userBand` across the whole width.
 * A blank source line stays a blank indented line, so a two-paragraph message keeps its
 * break. A mention the message listed keeps its own accent span (`layout-mentions.ts`),
 * inside the same band, so a view can pick the paths out of the text.
 */
function userLines(entry: UserEntry, context: LayoutContext): readonly StyledLine[] {
  const marker = styled(USER_MARKER, { color: "accent", background: USER_BAND });
  const gutter = styled(GUTTER, { background: USER_BAND });
  const band = (span: Span): Span => ({ ...span, background: USER_BAND });
  return userTextSpans(entry.text, entry.mentions ?? [], context.width - GUTTER_WIDTH).map((spans, index) => {
    // The marker carries its own trailing space; every other line's gutter is the two
    // spaces themselves, so the content starts at the same column either way. A blank
    // line is drawn as its gutter alone, never with a trailing space.
    const content = spans.map(band);
    if (index > 0) return line([gutter, ...content]);
    return line(content.length === 0 ? [marker] : [marker, band(styled(SPACE)), ...content]);
  });
}

/**
 * A reply: its markdown rendered into the columns left behind the gutter, the first line
 * behind the bullet glyph and the rest behind two spaces, with code lines cut — never
 * wrapped — by the renderer at the width the block actually has. A line `renderMarkdown`
 * leaves wide on purpose — a table's source text, raw HTML, a quote — reaches
 * `prefixedLine` still wide and is wrapped there rather than lost.
 */
function replyLines(entry: ReplyEntry, context: LayoutContext): readonly StyledLine[] {
  const rendered = renderMarkdown(entry.text, {
    width: context.width - GUTTER_WIDTH,
    theme: context.theme,
    minWidth: MIN_REPLY_WIDTH,
    cutCode: true,
  });
  const marker = styled(`${context.theme.glyphs.bullet}${SPACE}`);
  const gutter = styled(GUTTER);
  return rendered.flatMap((spans, index) => prefixedLine(spans, [index === 0 ? marker : gutter], context));
}

/** `✻ Thought for 6s (ctrl+o to show)` — how a finished thinking block describes itself. */
function thoughtHeader(entry: ThinkingEntry, context: LayoutContext): readonly StyledLine[] {
  const seconds = secondsBetween(entry.startedAt, entry.endedAt);
  const glyph = context.theme.glyphs.thinking;
  const hint = context.expanded ? HIDE_HINT : SHOW_HINT;
  const label = `${glyph} ${THOUGHT_FOR} ${seconds}${SECONDS_SUFFIX} ${hint}`;
  return wrapText(label, context.width).map(thoughtLine);
}

/**
 * A thinking block: nothing while it is still streaming (its text would arrive line by
 * line and jump), then one muted italic line stating how long it took and how to open it.
 * Expanded, that line names the way back and the thought follows, muted and indented.
 */
function thinkingLines(entry: ThinkingEntry, context: LayoutContext): readonly StyledLine[] {
  if (entry.endedAt === undefined) return [];
  const header = thoughtHeader(entry, context);
  if (!context.expanded) return header;
  const thought = textLines(entry.text).flatMap((source) =>
    wrappedSource(source, context.width - GUTTER_WIDTH).map((content) => thoughtLine(GUTTER + content)),
  );
  return [...header, ...thought];
}

/** A skill's slash invocation, muted line count, and optional indented body. */
function skillLines(entry: Extract<TranscriptEntry, { kind: "skill" }>, context: LayoutContext): readonly StyledLine[] {
  const sources = entry.body === "" ? [] : entry.body.replace(/(?:\r\n|[\r\n])$/, "").split(SOURCE_LINE_BREAK);
  const invocation = `/${entry.name}${entry.args === "" ? "" : SPACE + entry.args}`;
  const user = userLines({ kind: "user", text: invocation }, context);
  const indent = cardIndent(context.theme);
  const unit = sources.length === 1 ? "line" : "lines";
  const hint = context.expanded ? HIDE_HINT : SHOW_HINT;
  const label = `skill ${entry.name} · ${sources.length} ${unit} ${hint}`;
  const header = cardRows(label, { head: resultPrefix(context.theme), rest: indent }, { color: "muted" }, context);
  if (!context.expanded) return [...user, ...header];
  const body = sources.flatMap((source) =>
    cardRows(source, { head: indent, rest: indent }, { color: "muted" }, context),
  );
  return [...user, ...header, ...body];
}

/**
 * The card's header: the bullet in its tone's colour, then a space, the title, and the
 * argument in bold parentheses — the title alone when the call carries no argument. Both
 * are single-row data, so a line break in either is flattened rather than given a row.
 */
function toolHeader(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  const bullet = styled(context.theme.glyphs.bullet, { color: BULLET_COLORS[model.tone] });
  const argument = model.arg === undefined ? [] : [styled(`(${oneLine(sanitizeText(model.arg))})`, { bold: true })];
  return prefixedLine([styled(oneLine(sanitizeText(model.title))), ...argument], [bullet, styled(SPACE)], context);
}

/** The colour a summary line takes; a plain line keeps the terminal's own. */
function summaryColor(tone: CardLine["tone"]): ChatColorToken | undefined {
  return tone === "plain" ? undefined : tone;
}

/** The result summary: the glyph opens the first row, five blank columns every other. */
function toolSummaryLines(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  const head = resultPrefix(context.theme);
  const rest = cardIndent(context.theme);
  return model.summary.flatMap((line, index) =>
    cardRows(line.text, { head: index === 0 ? head : rest, rest }, { color: summaryColor(line.tone) }, context),
  );
}

/**
 * A diff line's style: the theme's background band when it has one, and the tone's colour
 * when it does not — a 16-colour terminal has no background to spare for a diff, and a
 * diff drawn in no colour at all would be unreadable.
 */
function diffStyle(sign: DiffLine["sign"], theme: ChatTheme): SpanStyle {
  if (sign === " ") return {};
  const background: ChatColorToken = sign === "-" ? "diffRemove" : "diffAdd";
  if (theme.colors[background] !== undefined) return { background };
  const color: ChatColorToken = sign === "-" ? "danger" : "success";
  return { color };
}

/** An Edit's diff behind the card's indent, each line banded by what it did to the file. */
function toolDiffLines(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  const indent = cardIndent(context.theme);
  return model.diff.flatMap((line) => {
    const style = diffStyle(line.sign, context.theme);
    const text = `${line.sign}${oneLine(sanitizeText(line.text))}`;
    return prefixedLine([styled(text, style)], [styled(indent, style)], context);
  });
}

/** The last row of a collapsed card: how many lines ctrl+o would reveal. */
function toolHiddenLine(model: ToolCardModel, context: LayoutContext): readonly StyledLine[] {
  if (model.hiddenLines === 0) return [];
  const label = `${context.theme.glyphs.ellipsis} ${HIDDEN_LINE_MARK}${model.hiddenLines} ${EXPAND_HINT}`;
  const indent = cardIndent(context.theme);
  return cardRows(label, { head: indent, rest: indent }, { color: "muted" }, context);
}

/**
 * A tool card: its header, the result summary, an Edit's diff and, while the card is
 * collapsed, the count of the lines ctrl+o would reveal. The model carries tones, not
 * colours, so the same card draws on any terminal.
 */
function toolLines(entry: ToolEntry, context: LayoutContext): readonly StyledLine[] {
  const model = toolCardModel(entry, { expanded: context.expanded });
  return [
    ...toolHeader(model, context),
    ...toolSummaryLines(model, context),
    ...toolDiffLines(model, context),
    ...toolHiddenLine(model, context),
  ];
}

/** One entry's lines, dispatched over every kind of the union. */
function layoutEntry(entry: TranscriptEntry, context: LayoutContext): readonly StyledLine[] {
  switch (entry.kind) {
    case "user":
      return userLines(entry, context);
    case "attachment":
      return attachmentLines(entry, context);
    case "skill":
      return skillLines(entry, context);
    case "reply":
      return replyLines(entry, context);
    case "thinking":
      return thinkingLines(entry, context);
    case "tool":
      return toolLines(entry, context);
    case "welcome":
      return welcomeLines(entry, context);
    case "notice":
    case "warning":
    case "error":
      return statusLines(entry, context);
    case "listing":
      return listingLines(entry, context);
    case "interrupted":
      return interruptedLines(context);
  }
}

/**
 * Injected seams. `layoutEntry` draws one entry for a layout context, and the per-entry
 * cache in `layoutTranscript` is only observable through it, so a test can count what a
 * call actually recomputed.
 */
export const _layoutDeps = {
  layoutEntry,
};

/** The separator between the two numbers of a variant key; no width or flag can hold it. */
const VARIANT_KEY_SEPARATOR = ":";

/** The lines one entry object has been laid out as, and the theme they were drawn for. */
interface CachedEntry {
  readonly theme: ChatTheme;
  readonly variants: Map<string, readonly StyledLine[]>;
}

/**
 * Per-entry lines, keyed by the entry object itself so an entry the transcript dropped is
 * collected with it. The reducer replaces only the entries an event touched, so an
 * unchanged entry keeps its object — and this cache keeps its lines.
 */
const LINE_CACHE = new WeakMap<TranscriptEntry, CachedEntry>();

function variantKey(width: number, expanded: boolean): string {
  return `${width}${VARIANT_KEY_SEPARATOR}${expanded}`;
}

/** The variants to store this entry's next line set in, discarding a stale theme's. */
function variantsFor(entry: TranscriptEntry, theme: ChatTheme): Map<string, readonly StyledLine[]> {
  const cached = LINE_CACHE.get(entry);
  if (cached !== undefined && cached.theme === theme) return cached.variants;
  const variants = new Map<string, readonly StyledLine[]>();
  LINE_CACHE.set(entry, { theme, variants });
  return variants;
}

/**
 * Cache by width and effective expansion (`open ?? expanded` for collapsible entries).
 * Entry identity bounds retention; replacing a clicked entry invalidates only its layout.
 * A different theme discards its variants so colours and glyphs never leak across themes.
 */
function cachedLines(entry: TranscriptEntry, base: LayoutContext): readonly StyledLine[] {
  const context =
    entry.kind === "thinking" || entry.kind === "tool" || entry.kind === "skill" || entry.kind === "attachment"
      ? { ...base, expanded: entry.open ?? base.expanded }
      : base;
  const variants = variantsFor(entry, context.theme);
  const key = variantKey(context.width, context.expanded);
  const cached = variants.get(key);
  if (cached !== undefined) return cached;
  const lines = _layoutDeps.layoutEntry(entry, context);
  variants.set(key, lines);
  return lines;
}

/**
 * The transcript as styled lines: each entry's lines in order, with one empty line
 * between the entries that produced any — an entry with nothing to draw (a thinking block
 * still streaming) adds no separator.
 */
export function layoutTranscript(entries: readonly TranscriptEntry[], options: LayoutOptions): readonly StyledLine[] {
  const context: LayoutContext = {
    width: resolveWidth(options.width),
    theme: options.theme,
    expanded: options.expanded,
  };
  const lines: StyledLine[] = [];
  for (const entry of entries) {
    const entryLines = cachedLines(entry, context);
    if (entryLines.length === 0) continue;
    if (lines.length > 0) lines.push(EMPTY_LINE);
    lines.push(...entryLines);
  }
  return lines;
}

/** Entry indices for the same cached layout, with unowned inter-entry separators. */
export function transcriptLineOwners(
  entries: readonly TranscriptEntry[],
  options: LayoutOptions,
): readonly (number | undefined)[] {
  const owners: (number | undefined)[] = [];
  entries.forEach((entry, index) => {
    const count = layoutTranscript([entry], options).length;
    if (count === 0) return;
    if (owners.length > 0) owners.push(undefined);
    owners.push(...Array.from({ length: count }, () => index));
  });
  return owners;
}
