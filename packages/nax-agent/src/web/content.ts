/**
 * Web content: the URL and text helpers every web tool result goes through.
 *
 * `normalizeWebUrl` is the single spelling of a URL in this subsystem: whatever a
 * model, a page or a typed chat message produces is reduced to one form before it
 * is recorded or compared, so `HTTPS://Example.COM:443/x#y` and `https://example.com/x`
 * cannot both occupy the seen-URL set. Only `http:` and `https:` survive; anything
 * else is `null`, which callers drop rather than coerce.
 */

const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** An http(s) URL in free text: runs to the next whitespace, then is trimmed. */
const URL_IN_TEXT = /\bhttps?:\/\/\S+/gi;

/** Punctuation a URL picks up from the sentence around it, never part of the URL. */
const TRAILING_PUNCTUATION = /[).,;:!?'"]+$/;

/** The element every web tool result is wrapped in. */
const FENCE_TAG = "web-content";

/**
 * The line that closes every fenced web result, exported as the one spelling of it.
 *
 * Both ends of the fence need it: `fenceWebContent` writes it, and the model-facing
 * truncation policy (`tools/spill.ts`) keeps it — a head-direction cut drops the END of a
 * body, which is exactly where this line is, and a result that loses it is an unterminated
 * untrusted block. `content.ts` imports nothing, so a tool module may import this without
 * closing a cycle.
 */
export const WEB_CONTENT_CLOSE_LINE = `</${FENCE_TAG}>`;

/** A closing tag of the fence, in any case, wherever it appears in the page text. */
const FENCE_CLOSE_TAG = /<\/web-content/gi;

/** `<` and `/` are two characters, so a match's name starts at index 2. */
const FENCE_CLOSE_TAG_PREFIX = 2;

/**
 * A URL in the one spelling this subsystem compares and records: lowercased scheme
 * and host, no fragment, no default port (80 for http, 443 for https), and path and
 * query kept exactly as written. Returns `null` for anything that is not an http(s)
 * URL, including unparseable text.
 */
export function normalizeWebUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Unparseable input is a normal answer here, not an error: free text, an empty
    // string and a malformed port all mean "no URL", and callers drop the null.
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  url.hash = "";
  return url.href;
}

/**
 * Every http(s) URL in free text, normalised, deduped and in first-seen order.
 * Trailing sentence punctuation is trimmed before normalising, so `see https://a.example/x)`
 * yields the URL rather than a path with a stray bracket. A URL that does not normalise
 * is dropped, the same way `normalizeWebUrl` reports it.
 */
export function extractWebUrls(text: string): readonly string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const normalized = normalizeWebUrl(match[0].replace(TRAILING_PUNCTUATION, ""));
    if (normalized !== null) found.add(normalized);
  }
  return [...found];
}

/**
 * The text a model reads for a web tool result: the page wrapped in a `<web-content>`
 * element that names where it came from, when it was read, and that it is untrusted.
 *
 * Two escapes keep a page from escaping its own fence: every `</web-content` in the
 * text, in any case, becomes `&lt;/web-content`, and every `"` in the source becomes
 * `%22` so it cannot close the attribute. The rest of the matched tag keeps the page's
 * case, which is what a reader needs to see to know the original bytes were rewritten.
 */
export function fenceWebContent(p: { source: string; fetchedAt: Date; text: string }): string {
  const source = p.source.replace(/"/g, "%22");
  const text = p.text.replace(FENCE_CLOSE_TAG, (match) => `&lt;/${match.slice(FENCE_CLOSE_TAG_PREFIX)}`);
  return `<${FENCE_TAG} source="${source}" fetched="${p.fetchedAt.toISOString()}" untrusted="true">\n${text}\n${WEB_CONTENT_CLOSE_LINE}`;
}
