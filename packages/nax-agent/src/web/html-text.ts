/**
 * Web content: static HTML reduced to the text a model can read, its title and its links.
 *
 * This is a hand-written converter, not a parser. nax-agent publishes to npm with a short
 * dependency list, and a page fetch is not worth another one, so the rules are the ones the
 * web tool family actually needs: the contents of `script`, `style`, `noscript`, `template`,
 * `svg` and the page's chrome never reach the text; block elements break the line, headings
 * become `#` lines, list items become `- ` lines and a `pre` block keeps its spacing inside a
 * fence. Everything else is text, and its entities are decoded once.
 *
 * The one piece of state the conversion carries is the link stack: an `<a href>` opens it and
 * its `</a>` closes it, so the absolute URL lands beside the link's own text and is collected,
 * in first-seen order, for the caller to record. Resolving goes through `normalizeWebUrl`, the
 * subsystem's single spelling of a URL, so a link here and a URL in the seen-URL set cannot
 * disagree about the same destination.
 *
 * Text shaping is a second pass over the rendered string, deliberately: a decoder that ran
 * before the tags were read would turn `&lt;script&gt;` back into a tag, and one that ran
 * before the collapse would leave `&nbsp;` runs uncollapsed. `pre` content is lifted out
 * before that pass and put back after it, which is what keeps its spacing intact.
 */

import { normalizeWebUrl } from "./content.ts";

/** What one page reduces to: a title when it has one, the readable text, and its links. */
export interface HtmlText {
  readonly title?: string;
  readonly text: string;
  readonly links: readonly string[];
}

/**
 * Elements whose contents are not page text: code, styles, fallbacks, and an embedded
 * vector rendering that is an image in everything but name.
 */
const HIDDEN_TAGS: readonly string[] = ["script", "style", "noscript", "template", "svg"];

/**
 * The page's chrome and metadata. Dropped after the title has been read out of it, which is
 * the one thing in a `head` a reader wants.
 */
const CHROME_TAGS: readonly string[] = ["head", "title", "nav", "footer"];

/** An HTML comment, including one left unterminated at the end of the page. */
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/**
 * The marker a lifted-out `pre` block leaves behind. It is a private-use character, which no
 * page has a reason to carry, and every occurrence is stripped from the page before anything
 * else runs -- so a page cannot forge a placeholder and have its text replaced.
 */
const MARK = "\uE000";

/** Every marker the page arrived with, removed so a placeholder cannot be forged. */
const MARK_IN_PAGE = /\uE000/g;

/** The document title, up to its first closing tag. */
const TITLE_ELEMENT = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;

/** A `pre` element with its contents, which are lifted out before the text is shaped. */
const PRE_ELEMENT = /<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi;

/** The newline a `pre` block's own source indentation starts with, which browsers drop too. */
const PRE_LEADING_NEWLINE = /^\r?\n/;

/** Where a lifted-out `pre` block sits, until it is put back. */
const PRE_PLACEHOLDER = /\uE000(\d+)\uE000/g;

/** The fence a `pre` block is rendered inside. */
const FENCE = "```";

/** Elements that open a line of their own, other than headings and list items. */
const BLOCK_TAGS: ReadonlySet<string> = new Set(["p", "div", "section", "article", "br", "tr"]);

/** A heading, capturing its level. */
const HEADING_TAG = /^h([1-6])$/;

/** A tag name, allowing the closing slash to lead. */
const TAG_NAME = /^\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/;

/** What may follow a `<` for a tag to start there; anything else makes the `<` text. */
const TAG_START = /[a-zA-Z/!?]/;

/** One attribute with a quoted or bare value, capturing the value in whichever form matched. */
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** A character reference: decimal, hexadecimal, or a named entity. */
const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * The named entities this converter decodes. Only the ones a static page is written with are
 * here: an unknown name is left as written rather than guessed at, because turning `&lang;`
 * into a guess would be worse than leaving it legible. `nbsp` decodes to a space, not to
 * U+00A0, so that a run of them collapses like any other space.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

/** The largest code point a character reference may name. */
const MAX_CODE_POINT = 0x10ffff;

/** The line item marker. */
const LIST_ITEM_MARKER = "- ";

/** The newline every block element emits on both sides of its contents. */
const BREAK = "\n";

/** A tag the tokenizer read: its name, its raw attribute text, and where it ends in the page. */
interface Tag {
  readonly name: string;
  readonly attrs: string;
  readonly closing: boolean;
  readonly end: number;
}

/** Every open `<a>`, in document order; `null` for one whose href named no destination. */
interface OpenLink {
  readonly url: string;
  readonly at: number;
}

/** Everything one conversion accumulates while the page is walked. */
interface RenderState {
  readonly out: string[];
  readonly links: string[];
  readonly seen: Set<string>;
  readonly openLinks: (OpenLink | null)[];
  readonly baseUrl: string;
}

/**
 * Convert an HTML page to the text a model reads, the title it declares and every http(s)
 * link on it, resolved against `baseUrl` and collected in first-seen order.
 */
export function htmlToText(html: string, baseUrl: string): HtmlText {
  const visible = dropElements(html.replace(MARK_IN_PAGE, "").replace(COMMENT, ""), HIDDEN_TAGS);
  const title = readTitle(visible);
  const { body, blocks } = liftPres(dropElements(visible, CHROME_TAGS));
  const state: RenderState = { out: [], links: [], seen: new Set(), openLinks: [], baseUrl };
  renderInto(body, state);
  const text = putPresBack(shapeText(decodeEntities(state.out.join(""))), blocks);
  return title === undefined ? { text, links: state.links } : { title, text, links: state.links };
}

/**
 * Remove the named elements, contents included. A paired element goes whole; a tag left
 * without its closing tag loses only the tag, so an unclosed `<script>` leaves its contents
 * as text rather than swallowing the rest of the page.
 */
function dropElements(html: string, tags: readonly string[]): string {
  return tags.reduce((text, tag) => dropElement(text, tag), html);
}

/** Remove one element's paired form, then any tag of that name left over. */
function dropElement(html: string, tag: string): string {
  const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
  const loneTag = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  return html.replace(paired, "").replace(loneTag, "");
}

/** The document's title, decoded and on one line; `undefined` when it has none worth reading. */
function readTitle(html: string): string | undefined {
  const match = TITLE_ELEMENT.exec(html);
  if (match === null) return undefined;
  const title = collapseInline(decodeEntities(match[1]));
  return title === "" ? undefined : title;
}

/** Text on one line: every whitespace run becomes a single space, then both ends are trimmed. */
function collapseInline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Lift every `pre` block out of the page, leaving a placeholder where it stood. The block is
 * rendered now, while its spacing is still its own; the placeholder survives text shaping,
 * which is the whole point of lifting it out first.
 */
function liftPres(html: string): { readonly body: string; readonly blocks: readonly string[] } {
  const blocks: string[] = [];
  const body = html.replace(PRE_ELEMENT, (_match: string, content: string) => {
    const token = preToken(blocks.length);
    blocks.push(fencePre(content));
    return `${BREAK}${token}${BREAK}`;
  });
  return { body, blocks };
}

/** The placeholder standing in for the `index`-th lifted-out `pre` block. */
function preToken(index: number): string {
  return `${MARK}${index}${MARK}`;
}

/** One `pre` block as a fenced code block, its spacing and entities kept as written. */
function fencePre(content: string): string {
  const text = decodeEntities(content.replace(PRE_LEADING_NEWLINE, "")).trimEnd();
  return `${FENCE}${BREAK}${text}${BREAK}${FENCE}`;
}

/** Put the lifted-out `pre` blocks back where their placeholders stand. */
function putPresBack(text: string, blocks: readonly string[]): string {
  return text.replace(PRE_PLACEHOLDER, (_match: string, index: string) => blocks.at(Number(index)) ?? "");
}

/**
 * Shape the rendered text: line endings unified, horizontal whitespace collapsed, no space
 * left hugging a newline, and a run of blank lines reduced to one.
 */
function shapeText(text: string): string {
  return text
    .replace(/\r\n?/g, BREAK)
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, BREAK)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Decode the character references this converter knows, in a single pass, so a decoded
 * reference is never decoded again: `&amp;lt;` is the text `&lt;`, not a `<`.
 */
function decodeEntities(text: string): string {
  return text.replace(ENTITY, (match: string, body: string) => decodeEntity(body) ?? match);
}

/** One character reference's decoded text, or `null` when it names nothing this decodes. */
function decodeEntity(body: string): string | null {
  if (!body.startsWith("#")) return NAMED_ENTITIES.get(body) ?? null;
  const isHex = body.charAt(1) === "x" || body.charAt(1) === "X";
  const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
  // 0 is refused rather than decoded: an invisible character the page cannot show is not
  // text, and the marker that stands in for a `pre` block must stay unforgeable.
  return Number.isInteger(code) && code > 0 && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : null;
}

/** Walk the page, emitting text and line breaks, and collecting the links it names. */
function renderInto(html: string, state: RenderState): void {
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) {
      state.out.push(html.slice(cursor));
      return;
    }
    if (start > cursor) state.out.push(html.slice(cursor, start));
    const tag = TAG_START.test(html.charAt(start + 1)) ? readTag(html, start) : null;
    if (tag === null) {
      state.out.push("<");
      cursor = start + 1;
      continue;
    }
    applyTag(tag, state);
    cursor = tag.end;
  }
}

/**
 * The tag starting at `start`, or `null` when the page ends before its `>`. A `>` inside a
 * quoted attribute value does not close the tag, which is what keeps `title="a>b"` whole.
 */
function readTag(html: string, start: number): Tag | null {
  let quote = "";
  for (let index = start + 1; index < html.length; index++) {
    const char = html.charAt(index);
    if (quote !== "") {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return buildTag(html.slice(start + 1, index), index + 1);
  }
  return null;
}

/** Split a tag's body into the name it opens or closes and the attributes behind it. */
function buildTag(body: string, end: number): Tag {
  const match = TAG_NAME.exec(body);
  const name = match === null ? "" : match[1];
  return { name: name.toLowerCase(), attrs: body, closing: body.trimStart().startsWith("/"), end };
}

/** Emit what one tag means for the text: a break, a heading, a list marker, or nothing. */
function applyTag(tag: Tag, state: RenderState): void {
  if (tag.name === "li") {
    state.out.push(tag.closing ? BREAK : LIST_ITEM_MARKER);
    return;
  }
  const heading = HEADING_TAG.exec(tag.name);
  if (heading !== null) {
    state.out.push(tag.closing ? BREAK : `${BREAK}${"#".repeat(Number(heading[1]))} `);
    return;
  }
  if (BLOCK_TAGS.has(tag.name)) {
    state.out.push(BREAK);
    return;
  }
  if (tag.name === "a") {
    applyAnchor(tag, state);
    return;
  }
}

/**
 * Open a link, or close it by writing its absolute URL beside the text it wrapped. Every
 * `<a>` is pushed, including one that records nothing, so each closing tag pairs with its own
 * opening tag rather than with an enclosing link.
 */
function applyAnchor(tag: Tag, state: RenderState): void {
  if (tag.closing) {
    closeAnchor(state);
    return;
  }
  const href = attributeValue(tag.attrs, "href");
  const url = href === null ? null : absoluteLink(href, state.baseUrl);
  if (url !== null && !state.seen.has(url)) {
    state.seen.add(url);
    state.links.push(url);
  }
  state.openLinks.push(url === null ? null : { url, at: state.out.length });
}

/**
 * Close the innermost open link. A link with no text of its own renders as its URL alone,
 * which is what an image-only or icon-only link leaves behind.
 */
function closeAnchor(state: RenderState): void {
  const open = state.openLinks.pop();
  if (open === undefined || open === null) return;
  const text = state.out.slice(open.at).join("").trim();
  state.out.push(text === "" ? open.url : ` (${open.url})`);
}

/** One attribute's value as the page wrote it; `null` when the attribute is absent. */
function attributeValue(attrs: string, name: string): string | null {
  for (const match of attrs.matchAll(ATTRIBUTE)) {
    if (match[1].toLowerCase() !== name) continue;
    return firstValue(match[2], match[3], match[4]);
  }
  return null;
}

/**
 * The first of an attribute's alternative value captures that actually matched. An empty
 * value counts as absent: it names no destination, so there is nothing to record.
 */
function firstValue(...candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "") return candidate;
  }
  return null;
}

/**
 * An href as the absolute URL this subsystem records, or `null` when it names no destination
 * worth recording: an in-page anchor (which resolves to the page itself, fragment stripped),
 * a non-http(s) scheme such as `mailto:`, or an href that will not resolve against the base.
 */
function absoluteLink(href: string, baseUrl: string): string | null {
  const target = decodeEntities(href).trim();
  if (target === "" || target.startsWith("#")) return null;
  try {
    return normalizeWebUrl(new URL(target, baseUrl).href);
  } catch {
    // An unparseable base, or an href that cannot be resolved against it, costs the link
    // its recorded URL only: the text it wrapped still renders.
    return null;
  }
}
