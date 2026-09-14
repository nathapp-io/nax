/**
 * Lexer and segmenter for a model-authored Bash command (spec §4 US-005.1-2).
 *
 * Safe-by-refusal, not safe-by-sandbox: any construct this lexer does not
 * MODEL is refused by name, because a payload the gate cannot read is a
 * payload no shell gets (spec R11). That is a deliberately small language —
 * words, quotes, operators, simple redirections — and growing it is a
 * permission decision, not a parser improvement.
 *
 * ZERO imports, on purpose. `src/permissions` must not value-import
 * `@/tools` (the edge runs the other way: src/tools/runtime.ts imports this
 * package), and a lexer that needs nothing is also a lexer that can be tested
 * without a filesystem, a policy or a spawn.
 */

/** One word of a segment. `opaque` means it contained `$`-expansion, so its
 * RUNTIME value is unknown here and policy-bash.ts refuses it before execution. */
export interface BashToken {
  readonly text: string;
  readonly opaque: boolean;
}

/** A simple redirection. The target is containment-checked by the caller. */
export interface BashRedirect {
  readonly operator: string;
  readonly target: string;
  readonly opaque: boolean;
}

/** The control operator that follows a command segment, when any. */
export type BashSegmentSeparator = ";" | "&&" | "||" | "|" | "&";

/** One command between control operators. */
export interface BashSegment {
  readonly tokens: readonly BashToken[];
  readonly redirects: readonly BashRedirect[];
  readonly separator?: BashSegmentSeparator;
}

export type BashLexResult =
  | { readonly kind: "ok"; readonly segments: readonly BashSegment[] }
  | { readonly kind: "refused"; readonly construct: string };

function refused(construct: string): BashLexResult {
  return { kind: "refused", construct };
}

/** End index of a double-quoted run starting at `from`, honouring backslash
 * escapes, or -1 when the quote is never closed. */
function doubleQuoteEnd(command: string, from: number): number {
  for (let i = from; i < command.length; i += 1) {
    const char = command[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === '"') return i;
  }
  return -1;
}

export function lexBashCommand(command: string): BashLexResult {
  // Checked up front so the reason names the real problem. Leaving it to the
  // final flushSegment() would report "an empty command segment", which is
  // true and useless.
  if (command.trim() === "") return refused("an empty command");

  const segments: BashSegment[] = [];
  let tokens: BashToken[] = [];
  let redirects: BashRedirect[] = [];
  let word = "";
  let opaque = false;
  let started = false;
  let pendingRedirect: string | undefined;

  function flushWord(): void {
    if (!started) return;
    if (pendingRedirect !== undefined) {
      redirects.push({ operator: pendingRedirect, target: word, opaque });
      pendingRedirect = undefined;
    } else {
      tokens.push({ text: word, opaque });
    }
    word = "";
    opaque = false;
    started = false;
  }

  /** Closes a segment, or names why it cannot be closed. A dangling operator
   * leaves an empty segment, which is refused rather than silently dropped:
   * `bun test &&` is a truncated command, and guessing at intent here would
   * approve something nobody wrote. */
  function flushSegment(separator?: BashSegmentSeparator): string | undefined {
    flushWord();
    if (pendingRedirect !== undefined) return "a redirection with no target";
    if (tokens.length === 0 && redirects.length === 0) return "an empty command segment";
    segments.push({ tokens, redirects, ...(separator === undefined ? {} : { separator }) });
    tokens = [];
    redirects = [];
    return undefined;
  }

  let i = 0;
  while (i < command.length) {
    const char = command[i] as string;
    const next = command[i + 1];

    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end === -1) return refused("an unbalanced single quote");
      // Single quotes suppress every expansion, so the content stays literal
      // and the token stays analysable.
      word += command.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }

    if (char === '"') {
      const end = doubleQuoteEnd(command, i + 1);
      if (end === -1) return refused("an unbalanced double quote");
      const inner = command.slice(i + 1, end);
      if (inner.includes("$(")) return refused("a command substitution `$(...)`");
      if (inner.includes("`")) return refused("a backtick command substitution");
      if (inner.includes("$")) opaque = true;
      word += inner;
      started = true;
      i = end + 1;
      continue;
    }

    if (char === "\\") {
      if (next === undefined) return refused("a trailing backslash");
      word += next;
      started = true;
      i += 2;
      continue;
    }

    if (char === "$" && next === "(") return refused("a command substitution `$(...)`");
    if (char === "`") return refused("a backtick command substitution");
    if ((char === "<" || char === ">") && next === "(") {
      return refused("a process substitution `<(...)` / `>(...)`");
    }
    if (char === "<" && next === "<") return refused("a here-document `<<`");
    if ((char === "<" || char === ">") && next === "&") {
      return refused("file-descriptor duplication (`2>&1`)");
    }
    if (char === "&" && next === ">") return refused("the `&>` redirection form");

    if (char === "$") {
      opaque = true;
      word += char;
      started = true;
      i += 1;
      continue;
    }

    if (char === " " || char === "\t" || char === "\r") {
      flushWord();
      i += 1;
      continue;
    }

    if (char === "\n" || char === ";") {
      const error = flushSegment(";");
      if (error !== undefined) return refused(error);
      i += 1;
      continue;
    }
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      const error = flushSegment(char === "&" ? "&&" : "||");
      if (error !== undefined) return refused(error);
      i += 2;
      continue;
    }
    if (char === "|" || char === "&") {
      const error = flushSegment(char);
      if (error !== undefined) return refused(error);
      i += 1;
      continue;
    }

    if (char === ">" || char === "<") {
      // A bare fd digit belongs to the operator (`2>err.txt`), not to argv:
      // left in the token list it would have to satisfy an allow rule, and
      // `Bash(bun test *)` would refuse a command it plainly covers.
      if (/^\d$/.test(word)) {
        word = "";
        started = false;
      }
      flushWord();
      let operator = char;
      if (char === ">" && next === ">") {
        operator = ">>";
        i += 1;
      }
      pendingRedirect = operator;
      i += 1;
      continue;
    }

    word += char;
    started = true;
    i += 1;
  }

  const error = flushSegment();
  if (error !== undefined) return refused(error);
  return { kind: "ok", segments };
}
