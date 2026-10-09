/**
 * Key-aware redaction of secrets embedded in JSON- and env-shaped text.
 *
 * `SECRET_VALUE_PATTERNS` matches token *shapes*; it cannot see
 * `{"client_secret": "plainvalue123"}` or `API_TOKEN=abc` because the value has
 * no recognisable shape. These patterns key off the NAME instead, using the
 * same unanchored-substring secret-key set as `SECRET_KEY_PATTERN` (a name
 * merely containing a secret-ish word counts), and mask only the value so the
 * key and the surrounding structure stay readable.
 *
 * These patterns are linear in the input (no nested quantifiers, no
 * catastrophic backtracking): keys are capped at 64 characters either side of
 * the keyword, and a value is the last element of its pattern so consuming it
 * never backtracks. `redactSecrets` as a whole also runs the older
 * `SECRET_VALUE_PATTERNS`, which carry their own cost profile. Values are not
 * length-capped here; callers bound the scan (`capStrings`).
 *
 * `_URL` is not a text-side key: `avatar_url` / `BASE_URL` values stay visible,
 * and credentials in a URL are masked by the userinfo pattern.
 *
 * Deliberately NOT here: `SECRET_VALUE_PATTERNS` stays the shell-command
 * masker's list (approval prompts reject spans containing quotes), so these
 * live in their own list that only `redactString` applies.
 */

const REDACTED = "[REDACTED]";

// Text-side keyword set. Same intent as SECRET_KEY_PATTERN; TOKEN(?!s\b) keeps
// plural usage counts (tokens, inputTokens, max_tokens) out. The key separator
// may be `-` as well as `_` (x-api-key). `_URI`/`_DSN` need a character before
// the underscore, as in SECRET_KEY_PATTERN.
const KEYWORD = String.raw`(?:SECRET|TOKEN(?!s\b)|API[_-]?KEY|PASSWORD|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|WEBHOOK|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWD|(?<=[\w.-])_(?:URI|DSN)|CONNECTION_?STRING)`;
const KEY = String.raw`[\w.-]{0,64}?${KEYWORD}[\w.-]{0,64}`;

/** A double-quoted JSON/YAML string body: escapes consumed pairwise, never past the closing quote. */
const DQ_BODY = String.raw`(?:[^"\\\r\n]|\\.)+`;
/** The body of a string inside JSON-in-a-string, where the closing quote is itself escaped (`\"`). */
const ESCAPED_BODY = String.raw`(?:[^"\\\r\n]|\\(?!\\*"))+`;
const SQ_BODY = String.raw`[^'\r\n]+`;

/**
 * An unquoted value is left alone when it is a reference or a type rather than
 * a credential: `$VAR`, `${VAR}`, `process.env.X`, `: string`, `=true`, and an
 * already-masked span.
 */
const NOT_A_REFERENCE = String.raw`(?!["'$<{(\[]|process\.|import\.meta|os\.|env\.|await\b|new\b|[\w.]+\(|(?:string|number|boolean|str|int|any|unknown|undefined|null|true|false|none)(?![\w-]))`;
/** `token_count: 5` is a usage figure, not a credential. */
const NOT_A_TOKEN_COUNT = String.raw`(?![\w.-]{0,64}?TOKEN(?!s\b)[\w.-]{0,64}[ \t]{0,8}[=:][ \t]{0,8}\d+(?![\w.-]))`;
const AUTH_SCHEME = String.raw`(?:(?:Bearer|Basic|Digest|Token)[ \t]+)?`;

interface StructuredPattern {
  readonly re: RegExp;
}

/** Each pattern captures the text to keep as group 1 and the value to mask as group 2. */
const STRUCTURED_PATTERNS: readonly StructuredPattern[] = [
  // {"apiKey": "v"}, any whitespace around the colon.
  { re: new RegExp(String.raw`("${KEY}"\s{0,256}:\s{0,256}")(${DQ_BODY})`, "gi") },
  // Python reprs / single-quoted JSON: {'apiKey': 'v'}, {'apiKey': "v"}.
  { re: new RegExp(String.raw`('${KEY}'\s{0,256}:\s{0,256}')(${SQ_BODY})`, "gi") },
  { re: new RegExp(String.raw`('${KEY}'\s{0,256}:\s{0,256}")(${DQ_BODY})`, "gi") },
  // JSON inside a JSON string: {\"apiKey\": \"v\"}.
  { re: new RegExp(String.raw`(\\{1,3}"${KEY}\\{1,3}"\s{0,256}:\s{0,256}\\{1,3}")(${ESCAPED_BODY})`, "gi") },
  // export OPENAI_API_KEY="v", secret_key: "v".
  { re: new RegExp(String.raw`(?<![\w.-])(${KEY}[ \t]{0,8}[=:][ \t]{0,8}")(${DQ_BODY})`, "gi") },
  // SECRET_KEY='v'
  { re: new RegExp(String.raw`(?<![\w.-])(${KEY}[ \t]{0,8}[=:][ \t]{0,8}')(${SQ_BODY})`, "gi") },
  // API_TOKEN=v, password: v, x-api-key: v, Authorization: Bearer v.
  {
    re: new RegExp(
      String.raw`(?<![\w.-])${NOT_A_TOKEN_COUNT}(${KEY}[ \t]{0,8}[=:][ \t]{0,8})${NOT_A_REFERENCE}(${AUTH_SCHEME}[^\s"',]+)`,
      "gi",
    ),
  },
];

/** Mask the value of every secret-named key in JSON-, dotenv-, shell- or YAML-shaped text. */
export function redactStructured(text: string): string {
  let out = text;
  for (const { re } of STRUCTURED_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (_match, keep: string) => `${keep}${REDACTED}`);
  }
  return out;
}
