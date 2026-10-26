/**
 * Tool cards — the pure model behind one transcript tool row: its title, its
 * one-line argument, its tone and its summary lines.
 *
 * The model carries no colour and no glyph: `CardLine.tone` names an intent and
 * the layout (`layout.ts`) maps it to a theme token, so the same card renders on
 * a light terminal, a 16-colour terminal or with colour off.
 */
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

function summaryFor(entry: ToolEntry, tone: ToolCardModel["tone"]): readonly CardLine[] {
  if (tone === "danger") return [danger(firstNonEmptyLine(entry.preview) ?? FAILED)];
  if (tone === "running" && entry.name === AGENT_RUN_TOOL) return childSummary(entry.children);
  return [];
}

/** The card for one tool entry. `expanded` lifts the line caps and widens the ok summary. */
// biome-ignore lint/correctness/noUnusedFunctionParameters: `expanded` drives the ok summary and the line caps, which US-006 adds; the title, arg, tone and the running/error summaries this model owns today do not depend on it.
export function toolCardModel(entry: ToolEntry, options: { expanded: boolean }): ToolCardModel {
  const arg = toolArg(entry.name, entry.input);
  const tone = toolTone(entry.status);
  return {
    title: toolTitle(entry.name),
    ...(arg === undefined ? {} : { arg }),
    tone,
    summary: summaryFor(entry, tone),
    diff: [],
    hiddenLines: 0,
  };
}
