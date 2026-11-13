/**
 * URL userinfo redaction for text that reaches a human or a transcript.
 *
 * A remote URL routinely carries its own authentication — a token pasted in
 * front of the host (`https://x-access-token:…@github.com/o/r.git`) — so any
 * place that echoes a URL back (a rejection naming the origin remote, git's
 * stderr inside a thrown error) names the credential unless it is redacted
 * first. Only the userinfo is dropped: the scheme, host and path stay, so the
 * message still says *which* endpoint was rejected.
 *
 * SCP-style addresses (`git@github.com:o/r.git`) are left alone. Their user is
 * the fixed SSH account, not a credential, and it has no `scheme://` prefix to
 * anchor on.
 *
 * This is narrower than `redactSecrets` (`@/logger`), which masks token-shaped
 * values wherever they appear: here the shape of the URL is what is being
 * matched, so a password that looks like nothing in particular is still caught.
 */

/** `scheme://userinfo@` — everything before the first `/` of the path. Greedy to the last `@` of the userinfo. */
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/gi;
/** `***` stands where the userinfo was, so the reader sees that a credential is present but not what it is. */
const REDACTED_USERINFO = "$1***@";

/**
 * Text with the userinfo of every URL in it replaced by `***`.
 *
 * @param text - A URL, or any text that may contain one (git stderr, a message)
 * @returns The same text with credentials removed
 */
export function redactUrlUserinfo(text: string): string {
  return text.replace(URL_USERINFO_RE, REDACTED_USERINFO);
}
