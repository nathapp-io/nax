/**
 * The exec helper's wire contract (US-003): one request line in, one reply line
 * out.
 *
 * Held apart from the process boundary (helper-process.ts) and the source itself
 * (exec-source.ts) because this is the part koda implements against, and because
 * every rule here is fail-closed: anything this module cannot name with certainty
 * is invalid, never a best-effort read of the nearest field.
 */

/** The request/reply protocol version this source speaks. */
export const REQUEST_VERSION = 1;

/** The subcommand appended to the configured command. */
export const HELPER_SUBCOMMAND = "get";

/** A longer credential is a malformed reply, not a key to try. */
const MAX_KEY_CHARS = 8_192;

/** The non-secret account label's length cap. */
const MAX_ACCOUNT_CHARS = 200;

/**
 * One credential as the helper reported it. `expiresAt` absent means the lease
 * is good for the life of the process; `account` is a label, never a secret.
 */
export interface Lease {
  key: string;
  expiresAt?: number;
  account?: string;
}

/** What a helper's stdout said. */
export type ParsedReply =
  | { kind: "credential"; lease: Lease }
  | { kind: "decline" }
  | { kind: "invalid"; detail: string };

/** The one JSON line written to the helper's stdin. */
export function requestLine(providerId: string): string {
  return `${JSON.stringify({ version: REQUEST_VERSION, providerId })}\n`;
}

/** Validate one credential or decline reply, fail-closed. */
export function parseReply(stdout: string): ParsedReply {
  const invalid = (detail: string): ParsedReply => ({ kind: "invalid", detail });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // The parser's message quotes the text it failed on, so it carries a fragment
    // of stdout — which is where the key lives. The reply is malformed either
    // way, and the caller has the code; naming the parser's text would put a
    // secret in an error message, and from there in the CLI and the precheck
    // report. See the Secrets rule in docs/specs/SPEC-credential-sources.md.
    return invalid("stdout was not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return invalid("the reply was not a JSON object");
  }

  const reply = parsed as Record<string, unknown>;
  // Neither `version` nor `kind` is echoed back: both are helper-controlled and
  // unvalidated, so `JSON.stringify` on one would copy an arbitrarily large
  // subtree of stdout — which is where the key is — into the message. Naming the
  // field and the expected value is enough to debug a helper.
  if (reply.version !== REQUEST_VERSION) {
    return invalid(`version was not ${REQUEST_VERSION}`);
  }
  // The decline reply carries no kind, so it is recognised before the credential
  // fields are required.
  if (reply.decline === true) return { kind: "decline" };

  if (reply.kind !== "api-key") return invalid('kind was not "api-key"');

  const key = reply.key;
  if (typeof key !== "string" || key.length === 0) return invalid("the reply carried no key");
  if (key.length > MAX_KEY_CHARS) return invalid(`the key was longer than ${MAX_KEY_CHARS} characters`);

  const account = reply.account;
  if (account !== undefined && (typeof account !== "string" || account.length > MAX_ACCOUNT_CHARS)) {
    return invalid(`the account label was not a string of at most ${MAX_ACCOUNT_CHARS} characters`);
  }

  const expiresAt = reply.expiresAt;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
      return invalid("expiresAt was not a positive integer");
    }
    if (expiresAt < Date.now()) return invalid("expiresAt was already past on receipt");
  }

  return {
    kind: "credential",
    lease: {
      key,
      ...(typeof account === "string" ? { account } : {}),
      ...(typeof expiresAt === "number" ? { expiresAt } : {}),
    },
  };
}
