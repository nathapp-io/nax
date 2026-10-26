/**
 * Tool cards — the pure model behind one transcript tool row: its title, its
 * one-line argument, its tone, its summary lines and (for an Edit) its diff.
 *
 * The model carries no colour and no glyph: `CardLine.tone` names an intent and
 * the layout (`layout.ts`) maps it to a theme token, so the same card renders on
 * a light terminal, a 16-colour terminal or with colour off.
 */
import { TOOL_RESULT_PREVIEW_BYTES } from "@nathapp/nax-agent";
import type { ToolChild, TranscriptEntry } from "./transcript-model";

/** One tool call in the transcript; the only entry kind a card renders. */
type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** One summary line, with the tone the layout paints it in. */
export interface CardLine {
  readonly text: string;
  readonly tone: "plain" | "muted" | "danger";
}

export interface DiffLine {
  readonly sign: "-" | "+" | " ";
  readonly text: string;
}

export interface ToolCardModel {
  readonly title: string;
  readonly arg?: string;
  readonly tone: "running" | "success" | "danger";
  readonly summary: readonly CardLine[];
  readonly diff: readonly DiffLine[];
  /** Lines withheld while collapsed; 0 when expanded or nothing is withheld. */
  readonly hiddenLines: number;
}

/** Longest argument shown beside a tool's title; the rest is elided. */
export const TOOL_ARG_LIMIT = 60;
/** A collapsed Bash result shows this many preview lines. */
export const BASH_PREVIEW_LINES = 3;
/** A collapsed Edit diff shows this many lines. */
export const DIFF_PREVIEW_LINES = 12;
/** A running agent card previews this many of its nested tool calls. */
export const CHILD_PREVIEW_LINES = 3;

/** The elision mark. Theme-independent on purpose: an argument is data, not decoration. */
const ELLIPSIS = "…";
/** The provider-qualified name of the `nax-agents` provider's `run` tool. */
const AGENT_RUN_TOOL = "nax-agents__run";
/** The provider-qualified name of the `nax-skills` provider's `load` tool. */
const SKILL_LOAD_TOOL = "nax-skills__load";
/** Tools whose argument is the file they touch. */
const PATH_TOOLS: ReadonlySet<string> = new Set(["Read", "Write", "Edit", "Delete"]);
const TITLES: ReadonlyMap<string, string> = new Map([
  [AGENT_RUN_TOOL, "Agent"],
  [SKILL_LOAD_TOOL, "Skill"],
]);
const FAILED = "failed";
/** What an ok card says when its tool reported no text of its own. */
const DONE = "Done";

function stringField(source: unknown, field: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = Reflect.get(source, field);
  return typeof value === "string" ? value : undefined;
}

/** Line breaks carry no meaning in a one-line argument. */
function oneLine(value: string): string {
  return value.replace(/\r\n|[\r\n]/g, " ");
}

/** The first line of a multi-line value, or the value itself when it has one. */
function firstLine(value: string | undefined): string | undefined {
  return value?.split(/\r\n|[\r\n]/)[0];
}

/**
 * A text's lines: one trailing newline is taken off (a file's final line break does
 * not open an empty last line), and an empty text has none.
 */
function splitLines(text: string): readonly string[] {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body === "" ? [] : body.split("\n");
}

/** The number of lines in `text`, by the same rule as `splitLines`. */
function lineCount(text: string): number {
  return splitLines(text).length;
}

/**
 * The card's title: the two provider tools get a plain name, everything else
 * keeps the name the session reported. The lookup is a `Map` so a tool named
 * after an `Object` member (`constructor`, `toString`, `__proto__`) comes back
 * as itself rather than as the inherited value.
 */
export function toolTitle(name: string): string {
  return TITLES.get(name) ?? name;
}

function grepArg(input: unknown): string | undefined {
  const pattern = stringField(input, "pattern");
  if (pattern === undefined) return undefined;
  const path = stringField(input, "path");
  return path === undefined ? `"${pattern}"` : `"${pattern}", ${path}`;
}

function agentArg(input: unknown): string | undefined {
  const agent = stringField(input, "agent");
  const task = stringField(input, "task");
  return agent === undefined || task === undefined ? undefined : `${agent}: ${task}`;
}

/** The argument the call carries, derived per tool; undefined when it carries none. */
function rawArg(name: string, input: unknown): string | undefined {
  if (PATH_TOOLS.has(name)) return stringField(input, "path");
  if (name === "Bash") return firstLine(stringField(input, "command"));
  if (name === "Grep") return grepArg(input);
  if (name === "Glob") return stringField(input, "pattern");
  if (name === "Git") return stringField(input, "subcommand");
  if (name === AGENT_RUN_TOOL) return agentArg(input);
  if (name === SKILL_LOAD_TOOL) return stringField(input, "name");
  return undefined;
}

/** `rawArg`, flattened to one line and elided at `TOOL_ARG_LIMIT` characters. */
function toolArg(name: string, input: unknown): string | undefined {
  const value = rawArg(name, input);
  if (value === undefined) return undefined;
  const flat = oneLine(value);
  return flat.length > TOOL_ARG_LIMIT ? `${flat.slice(0, TOOL_ARG_LIMIT)}${ELLIPSIS}` : flat;
}

function toolTone(status: ToolEntry["status"]): ToolCardModel["tone"] {
  if (status === "running") return "running";
  return status === "ok" ? "success" : "danger";
}

function muted(text: string): CardLine {
  return { text, tone: "muted" };
}

function danger(text: string): CardLine {
  return { text, tone: "danger" };
}

/** A nested call, shown the way a top-level card is titled: `Title(arg)`. */
function childLine(child: ToolChild): string {
  const arg = toolArg(child.name, child.input);
  return arg === undefined ? toolTitle(child.name) : `${toolTitle(child.name)}(${arg})`;
}

/** A running agent's children, newest last, with the ones the preview withholds counted. */
function childSummary(children: readonly ToolChild[]): readonly CardLine[] {
  const shown = children.slice(-CHILD_PREVIEW_LINES);
  const lines = shown.map((child) => muted(childLine(child)));
  const withheld = children.length - shown.length;
  return withheld === 0 ? lines : [muted(`+${withheld} more tool uses`), ...lines];
}

/** The first line with content in it; undefined when the text is empty or blank. */
function firstNonEmptyLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const line of text.split(/\r\n|[\r\n]/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

/** The summary of a call that has not succeeded: running (an agent's children) or error. */
function nonResultSummary(entry: ToolEntry, tone: ToolCardModel["tone"]): readonly CardLine[] {
  if (tone === "danger") return [danger(firstNonEmptyLine(entry.preview) ?? FAILED)];
  if (tone === "running" && entry.name === AGENT_RUN_TOOL) return childSummary(entry.children);
  return [];
}

/** Lines a card would show but withholds, and the count of the ones a collapse leaves out. */
interface Capped<T> {
  readonly shown: readonly T[];
  readonly hidden: number;
}

const NOTHING: Capped<never> = { shown: [], hidden: 0 };

/** The first `limit` items with the rest counted; an expanded card keeps every item. */
function capped<T>(items: readonly T[], limit: number, expanded: boolean): Capped<T> {
  if (expanded || items.length <= limit) return { shown: items, hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

function plain(text: string): CardLine {
  return { text, tone: "plain" };
}

/** The result text a tool reported; an unreported preview is the empty string. */
function previewText(entry: ToolEntry): string {
  return entry.preview ?? "";
}

/** The preview's lines; a missing or blank preview has none. */
function previewLines(entry: ToolEntry): readonly string[] {
  const text = previewText(entry);
  return text.trim() === "" ? [] : splitLines(text);
}

/** What a tool with no result text of its own reports: its first preview line, or `Done`. */
function textSummary(entry: ToolEntry): Capped<CardLine> {
  return { shown: [muted(firstNonEmptyLine(entry.preview) ?? DONE)], hidden: 0 };
}

function editSummary(entry: ToolEntry): Capped<CardLine> {
  const path = stringField(entry.input, "path");
  const oldText = stringField(entry.input, "old_string");
  const newText = stringField(entry.input, "new_string");
  if (path === undefined || oldText === undefined || newText === undefined) return textSummary(entry);
  const counts = `+${lineCount(newText)} -${lineCount(oldText)}`;
  return { shown: [muted(`Updated ${path} (${counts})`)], hidden: 0 };
}

function writeSummary(entry: ToolEntry): Capped<CardLine> {
  const path = stringField(entry.input, "path");
  const content = stringField(entry.input, "content");
  if (path === undefined || content === undefined) return textSummary(entry);
  return { shown: [muted(`Wrote ${lineCount(content)} lines to ${path}`)], hidden: 0 };
}

/** `+` marks a preview that filled the byte cap nax-agent applies, so its count is a floor. */
function readSummary(entry: ToolEntry): Capped<CardLine> {
  const preview = previewText(entry);
  const filledCap = Buffer.byteLength(preview, "utf8") >= TOOL_RESULT_PREVIEW_BYTES;
  return { shown: [muted(`Read ${lineCount(preview)}${filledCap ? "+" : ""} lines`)], hidden: 0 };
}

function bashSummary(entry: ToolEntry, expanded: boolean): Capped<CardLine> {
  const lines = previewLines(entry);
  if (lines.length === 0) return textSummary(entry);
  return capped(lines.map(plain), BASH_PREVIEW_LINES, expanded);
}

/** Whole seconds between two timestamps; a missing end or an unparseable pair counts as none. */
function secondsBetween(startedAt: string, endedAt: string | undefined): number {
  const start = Date.parse(startedAt);
  const end = endedAt === undefined ? start : Date.parse(endedAt);
  const seconds = Math.floor((end - start) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * A finished agent card states its outcome; collapsed it withholds the children (the
 * layout advertises them through `hiddenLines`), expanded it lists them after the summary.
 */
function agentSummary(entry: ToolEntry, expanded: boolean): Capped<CardLine> {
  const done = muted(
    `${DONE} (${entry.children.length} tool uses · ${secondsBetween(entry.startedAt, entry.endedAt)}s)`,
  );
  if (!expanded) return { shown: [done], hidden: entry.children.length };
  return { shown: [done, ...entry.children.map((item) => muted(childLine(item)))], hidden: 0 };
}

function okSummary(entry: ToolEntry, expanded: boolean): Capped<CardLine> {
  switch (entry.name) {
    case "Edit":
      return editSummary(entry);
    case "Write":
      return writeSummary(entry);
    case "Read":
      return readSummary(entry);
    case "Bash":
      return bashSummary(entry, expanded);
    case AGENT_RUN_TOOL:
      return agentSummary(entry, expanded);
    default:
      return textSummary(entry);
  }
}

/** Only a finished Edit has a diff: a Write shows what it wrote, not the file it replaced. */
function okDiff(entry: ToolEntry, expanded: boolean): Capped<DiffLine> {
  if (entry.name !== "Edit") return NOTHING;
  const oldText = stringField(entry.input, "old_string");
  const newText = stringField(entry.input, "new_string");
  if (oldText === undefined || newText === undefined) return NOTHING;
  return capped(diffLines(oldText, newText), DIFF_PREVIEW_LINES, expanded);
}

/** How many lines the two texts share at their start. */
function commonPrefixLength(oldLines: readonly string[], newLines: readonly string[]): number {
  let shared = 0;
  while (shared < oldLines.length && shared < newLines.length && oldLines[shared] === newLines[shared]) {
    shared += 1;
  }
  return shared;
}

/** How many lines the two texts share at their end, counting only what the prefix left over. */
function commonSuffixLength(oldLines: readonly string[], newLines: readonly string[], prefix: number): number {
  let shared = 0;
  while (
    shared < oldLines.length - prefix &&
    shared < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - shared] === newLines[newLines.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}

function diffLine(sign: DiffLine["sign"], text: string): DiffLine {
  return { sign, text };
}

/**
 * A line diff of two texts: the lines they share at the start and at the end stay
 * context, and between them the old text's remaining lines (removed) precede the new
 * text's (added). Edit carries no start line, so the diff is the replacement text
 * against the text it replaced rather than a marked-up file.
 */
export function diffLines(oldText: string, newText: string): readonly DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const prefix = commonPrefixLength(oldLines, newLines);
  const suffix = commonSuffixLength(oldLines, newLines, prefix);
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  return [
    ...oldLines.slice(0, prefix).map((text) => diffLine(" ", text)),
    ...oldChanged.map((text) => diffLine("-", text)),
    ...newChanged.map((text) => diffLine("+", text)),
    ...oldLines.slice(oldLines.length - suffix).map((text) => diffLine(" ", text)),
  ];
}

/** The card for one tool entry. `expanded` lifts the line caps and widens the ok summary. */
export function toolCardModel(entry: ToolEntry, options: { expanded: boolean }): ToolCardModel {
  const arg = toolArg(entry.name, entry.input);
  const tone = toolTone(entry.status);
  const succeeded = tone === "success";
  const summary = succeeded ? okSummary(entry, options.expanded) : { shown: nonResultSummary(entry, tone), hidden: 0 };
  const diff = succeeded ? okDiff(entry, options.expanded) : NOTHING;
  return {
    title: toolTitle(entry.name),
    ...(arg === undefined ? {} : { arg }),
    tone,
    summary: summary.shown,
    diff: diff.shown,
    hiddenLines: summary.hidden + diff.hidden,
  };
}
