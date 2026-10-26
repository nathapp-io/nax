/**
 * Syntax highlighting — the grammar a fenced code block is drawn with.
 *
 * The highlighter is the `highlight.js` **core** build with only the languages a coding
 * reply realistically carries registered, so the bundle does not ship every grammar the
 * package has. `highlight.js` already resolves the usual short names (`ts`, `js`, `sh`,
 * `zsh`, `py`, `yml`, `html`); `EXTRA_ALIASES` adds the ones it does not declare.
 *
 * Two conversions sit between the highlighter and a `Span`, and `codeLines` is where they
 * happen: its HTML output is turned back into text runs (its only tags are
 * `<span class="hljs-…">`, and every `<`, `>`, `&` in the code arrives escaped), and each
 * scope class is mapped onto a theme `syntax*` token. A scope the map does not know stays
 * plain, so a grammar update can never invent a colour. Nothing here throws: a language
 * the highlighter does not know, a missing one, and a highlighter that fails all render
 * the block as plain code, because a live reply must never be lost to a grammar bug.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { type Span, sanitizeText } from "./styled-line";
import type { ChatColorToken } from "./theme";

/** The highlighter seam: the highlighter's raw output for `code` in `language`. */
export type HighlightFn = (code: string, language: string) => string;

/** One run of highlighted code: its text and the colour its scope maps to. */
interface CodeRun {
  readonly text: string;
  readonly color?: ChatColorToken;
}

/** The languages this build ships, keyed by the name `registerLanguage` takes. */
const GRAMMARS: Readonly<Record<string, Parameters<typeof hljs.registerLanguage>[1]>> = {
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

/**
 * Short names the highlighter does not declare itself; everything else is its own alias
 * table. A `Map`, not an object literal: these keys are the reply's own text, and a plain
 * object would answer `constructor`, `toString` or `__proto__` from its prototype.
 */
const EXTRA_ALIASES: ReadonlyMap<string, string> = new Map([["shell", "bash"]]);

const HLJS_CLASS_PREFIX = "hljs-";
const SPACE = " ";
const LANGUAGE_SEPARATOR = /\s+/;
const LINE_BREAK = "\n";

/** Scope class (without the `hljs-` prefix) -> theme token. A `Map` for the same reason. */
const SCOPE_COLORS: ReadonlyMap<string, ChatColorToken> = new Map<string, ChatColorToken>([
  ["keyword", "syntaxKeyword"],
  ["built_in", "syntaxKeyword"],
  ["string", "syntaxString"],
  ["comment", "syntaxComment"],
  ["number", "syntaxNumber"],
  ["literal", "syntaxNumber"],
  ["title", "syntaxTitle"],
]);

/** Every escape the highlighter emits, so its output can be read back as text. */
const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
};

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|#x27);/g;

/** An opening span tag, a closing one, or a run of text — the whole grammar of the output. */
const OUTPUT_TAG_PATTERN = /<span class="([^"]*)">|<\/span>|([^<]+)/g;

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

/**
 * The language a fence declares — its first word, lower-cased and made safe to draw. The info
 * string is the reply's own text: it carries no trust, so it reaches `sanitizeText` here,
 * before it is either resolved as a grammar or written as span text. One value does both, so
 * the label and the grammar can never disagree.
 */
export function fenceLanguage(lang: string | undefined): string {
  if (lang === undefined) return "";
  return sanitizeText(lang.trim().split(LANGUAGE_SEPARATOR)[0]).toLowerCase();
}

/** The registered grammar `name` resolves to, or undefined when the highlighter has none. */
export function resolveCodeLanguage(name: string): string | undefined {
  if (name === "") return undefined;
  const resolved = EXTRA_ALIASES.get(name) ?? name;
  return hljs.getLanguage(resolved) === undefined ? undefined : resolved;
}

/** The highlighter's output for `code` — the default behind `_markdownDeps.highlight`. */
export function highlightToHtml(code: string, language: string): string {
  return hljs.highlight(code, { language }).value;
}

/** Plain code: one span per source line, drawn exactly as it arrived (tabs widened). */
function plainLines(body: string): readonly (readonly Span[])[] {
  return body.split(LINE_BREAK).map((line) => (line === "" ? [] : [{ text: sanitizeText(line) }]));
}

function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, (entity) => ENTITIES[entity] ?? entity);
}

/** The colour of a `class="…"` attribute — the first scope the map knows. */
function scopeColor(attribute: string): ChatColorToken | undefined {
  for (const name of attribute.split(SPACE)) {
    const scope = name.startsWith(HLJS_CLASS_PREFIX) ? name.slice(HLJS_CLASS_PREFIX.length) : name;
    const color = SCOPE_COLORS.get(scope);
    if (color !== undefined) return color;
  }
  return undefined;
}

/**
 * The innermost scope's colour: an unknown nested scope (`hljs-subst` inside `hljs-string`)
 * leaves the enclosing colour standing rather than dropping the token to plain.
 */
function innermostColor(open: readonly (ChatColorToken | undefined)[]): ChatColorToken | undefined {
  for (let index = open.length - 1; index >= 0; index -= 1) {
    const color = open[index];
    if (color !== undefined) return color;
  }
  return undefined;
}

/** The highlighter's output read back into styled runs of text. */
function runsOf(html: string): CodeRun[] {
  const runs: CodeRun[] = [];
  const open: (ChatColorToken | undefined)[] = [];
  for (const match of html.matchAll(OUTPUT_TAG_PATTERN)) {
    const [, attribute, text] = match;
    if (attribute !== undefined) {
      open.push(scopeColor(attribute));
      continue;
    }
    if (text === undefined) {
      open.pop();
      continue;
    }
    runs.push({ text: decodeEntities(text), color: innermostColor(open) });
  }
  return runs;
}

/** A styled run's text as span text — a colourless run carries no `color` key at all. */
function spanOf(run: CodeRun, text: string): Span {
  return run.color === undefined ? { text } : { text, color: run.color };
}

/** Split the runs on the newlines the highlighter preserved, one styled line per source line. */
function highlightedLines(html: string): readonly (readonly Span[])[] {
  const lines: Span[][] = [[]];
  for (const run of runsOf(html)) {
    for (const [index, part] of sanitizeText(run.text).split(LINE_BREAK).entries()) {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1].push(spanOf(run, part));
    }
  }
  return lines;
}

/**
 * The code lines of a fenced block, each as spans. A language the highlighter knows has
 * its tokens coloured by scope; no language, an unknown one, or a highlighter that throws
 * draws the lines plain. Language resolution is inside the same boundary as the highlight
 * call: the fence's info string is the reply's own text, so nothing it can name may throw
 * out of a render.
 *
 * The body is drawn exactly as the lexer handed it over: the lexer has already dropped the
 * newline that precedes the closing fence, so a fence that ends with a blank line keeps that
 * blank line here — trimming one more would silently delete a line of the user's code.
 */
export function codeLines(code: string, language: string, highlight: HighlightFn): readonly (readonly Span[])[] {
  try {
    const grammar = resolveCodeLanguage(language);
    return grammar === undefined ? plainLines(code) : highlightedLines(highlight(code, grammar));
  } catch {
    // A failing highlighter must not cost the user the reply: draw the code as it arrived.
    return plainLines(code);
  }
}
