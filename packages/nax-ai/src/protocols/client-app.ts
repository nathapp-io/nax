/**
 * Vendor spellings of the calling application's identity.
 *
 * The same split as `session-id.ts`, for the same reason: the consumer owns the
 * identity — what its application is called, and where it lives — and this
 * package owns which vendor spells that in which header. A consumer could set
 * these through `ProtocolRequest.headers`, but only by learning a vendor
 * vocabulary that this package exists to keep away from it.
 *
 * Nothing here is a consumer domain concept. A name and a URL are what a
 * provider's own attribution API asks for, and they end up in that provider's
 * records rather than in ours.
 *
 * pi-ai touches neither header at any version, and sets no per-model table for
 * them, so this is the only place they can come from. Without it every request
 * from every pi-ai consumer looks alike on a provider's dashboard: the sole
 * identifying header on the wire is pi-ai's own `User-Agent`, which reads
 * "pi (<platform> <release>; <arch>)" whatever is calling it.
 */

/**
 * How the calling application identifies itself upstream.
 *
 * Both fields are optional and independent: a consumer with no public URL can
 * still send a name. Construction-time rather than per-request — this is a
 * constant of the process, unlike a session id, which changes with the work.
 */
export interface ClientApp {
  /** Display name, e.g. "nax". */
  readonly name?: string;
  /** Public URL of the application. */
  readonly url?: string;
}

/**
 * Providers that read an application identity off the request.
 *
 * OpenRouter is the only one that documents a pair
 * (https://openrouter.ai/docs/api-reference/overview): `HTTP-Referer`
 * identifies the app and populates the `app_id`, `origin` and `http_referer`
 * fields of each generation record, and `X-Title` sets the display name
 * (`X-OpenRouter-Title` is accepted as well; the short spelling is the
 * documented one and the one every OpenRouter client sends).
 *
 * Left at one entry deliberately. A vendor table earns its place by recording
 * something a consumer could not know; guessing that another gateway reads the
 * same names would record something nobody knows.
 */
const VENDOR_APP_HEADERS: Readonly<Record<string, { readonly name: string; readonly url: string }>> = {
  openrouter: { name: "X-Title", url: "HTTP-Referer" },
};

/**
 * Returns undefined — not an empty object — whenever there is nothing to add,
 * so a caller merges nothing at all. Mirrors `vendorSessionHeaders`, including
 * its empty-string-is-absent rule and its own-property lookup: a plain object
 * literal inherits `constructor`, `toString` and friends, and indexing it with
 * one of those provider names would produce a header named after a function
 * body.
 */
export function vendorAppHeaders(
  provider: string,
  app: ClientApp | undefined,
): Readonly<Record<string, string>> | undefined {
  if (app === undefined) return undefined;
  if (!Object.hasOwn(VENDOR_APP_HEADERS, provider)) return undefined;
  const spelling = VENDOR_APP_HEADERS[provider];
  if (spelling === undefined) return undefined;

  const headers: Record<string, string> = {};
  if (app.url !== undefined && app.url !== "") headers[spelling.url] = app.url;
  if (app.name !== undefined && app.name !== "") headers[spelling.name] = app.name;
  return Object.keys(headers).length === 0 ? undefined : headers;
}
