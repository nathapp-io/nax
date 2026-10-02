/**
 * Lexer and segmenter for a model-authored Bash command (spec §4 US-005.1-2).
 *
 * Safe-by-refusal, not safe-by-sandbox: any construct this lexer does not
 * MODEL is refused by name, because a payload the gate cannot read is a
 * payload no shell gets (spec R11). That is a deliberately small language —
 * words, quotes, operators, simple redirections — and growing it is a
 * permission decision, not a parser improvement.
 *
 * "Refused by name" is the whole guarantee, so it must hold for EVERY
 * unmodelled construct, not only the ones that look dangerous. A construct
 * that folds into a word instead is worse than one that is modelled: the
 * segment still reaches the policy, and its first token is no longer the
 * command a deny rule was written against.
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
  | {
      readonly kind: "refused";
      readonly construct: string;
      /**
       * The lexable prefix at the point of refusal: the completed segments,
       * followed by the interrupted segment's completed tokens and redirects
       * only. The word being built when the refusal struck is dropped, as is a
       * redirect operator still waiting for its target; a trailing segment with
       * neither tokens nor redirects is omitted. `[]` when the refusal precedes
       * any completed word. The gate runs its deny and payload checks over this
       * prefix, so an out-of-bounds command never reaches the human just because
       * a later construct was unreadable.
       */
      readonly prefix: readonly BashSegment[];
    };

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

/** The lexer's mutable accumulators. Threaded BY REFERENCE through every
 * per-character handler and mutated in place: a refusal can strike at any
 * step, and the prefix contract reads whatever the interrupted segment had
 * completed — so state must never be handed back by value. */
interface LexerState {
  readonly command: string;
  readonly segments: BashSegment[];
  tokens: BashToken[];
  redirects: BashRedirect[];
  word: string;
  opaque: boolean;
  started: boolean;
  pendingRedirect: string | undefined;
}

/** One per-character step: consume `by` characters, or refuse by name. */
type LexStep =
  | { readonly kind: "advance"; readonly by: number }
  | { readonly kind: "refuse"; readonly construct: string };

/** Handles one character class at `i`, or returns `undefined` when the
 * character is not this handler's. Handlers run in a FIXED order (`HANDLERS`
 * below) — that order is part of the lexer's contract: `$(` must be tested
 * before `$`, `<<` before `<`, `&>` before `&`. */
type CharHandler = (state: LexerState, i: number) => LexStep | undefined;

export function lexBashCommand(command: string): BashLexResult {
  // Checked up front so the reason names the real problem. Leaving it to the
  // final flushSegment() would report "an empty command segment", which is
  // true and useless.
  if (command.trim() === "") return { kind: "refused", construct: "an empty command", prefix: [] };

  const state: LexerState = {
    command,
    segments: [],
    tokens: [],
    redirects: [],
    word: "",
    opaque: false,
    started: false,
    pendingRedirect: undefined,
  };

  let i = 0;
  while (i < command.length) {
    const step = stepAt(state, i);
    if (step === undefined) {
      // Plain word character: accumulates into the token being built.
      state.word += command[i] as string;
      state.started = true;
      i += 1;
      continue;
    }
    if (step.kind === "refuse") return refusedHere(state, step.construct);
    i += step.by;
  }

  const error = flushSegment(state);
  if (error !== undefined) return refusedHere(state, error);
  return { kind: "ok", segments: state.segments };
}

/** Snapshots the lexable prefix at a refusal site (see `BashLexResult`). The
 * in-progress `word` is deliberately excluded, and `pendingRedirect` -- an
 * operator awaiting its target -- lives outside `redirects`, so it is dropped
 * with it. */
function refusedHere(state: LexerState, construct: string): BashLexResult {
  const prefix =
    state.tokens.length === 0 && state.redirects.length === 0
      ? [...state.segments]
      : [...state.segments, { tokens: state.tokens, redirects: state.redirects }];
  return { kind: "refused", construct, prefix };
}

function flushWord(state: LexerState): void {
  if (!state.started) return;
  if (state.pendingRedirect !== undefined) {
    state.redirects.push({ operator: state.pendingRedirect, target: state.word, opaque: state.opaque });
    state.pendingRedirect = undefined;
  } else {
    state.tokens.push({ text: state.word, opaque: state.opaque });
  }
  state.word = "";
  state.opaque = false;
  state.started = false;
}

/** Closes a segment, or names why it cannot be closed. A dangling operator
 * leaves an empty segment, which is refused rather than silently dropped:
 * `bun test &&` is a truncated command, and guessing at intent here would
 * approve something nobody wrote. */
function flushSegment(state: LexerState, separator?: BashSegmentSeparator): string | undefined {
  flushWord(state);
  if (state.pendingRedirect !== undefined) return "a redirection with no target";
  if (state.tokens.length === 0 && state.redirects.length === 0) return "an empty command segment";
  state.segments.push({
    tokens: state.tokens,
    redirects: state.redirects,
    ...(separator === undefined ? {} : { separator }),
  });
  state.tokens = [];
  state.redirects = [];
  return undefined;
}

function lexSingleQuote(state: LexerState, i: number): LexStep | undefined {
  if (state.command[i] !== "'") return undefined;
  const end = state.command.indexOf("'", i + 1);
  if (end === -1) return { kind: "refuse", construct: "an unbalanced single quote" };
  // Single quotes suppress every expansion, so the content stays literal
  // and the token stays analysable.
  state.word += state.command.slice(i + 1, end);
  state.started = true;
  return { kind: "advance", by: end + 1 - i };
}

function lexDoubleQuote(state: LexerState, i: number): LexStep | undefined {
  if (state.command[i] !== '"') return undefined;
  const end = doubleQuoteEnd(state.command, i + 1);
  if (end === -1) return { kind: "refuse", construct: "an unbalanced double quote" };
  const inner = state.command.slice(i + 1, end);
  if (inner.includes("$(")) return { kind: "refuse", construct: "a command substitution `$(...)`" };
  if (inner.includes("`")) return { kind: "refuse", construct: "a backtick command substitution" };
  if (inner.includes("$")) state.opaque = true;
  state.word += inner;
  state.started = true;
  return { kind: "advance", by: end + 1 - i };
}

function lexEscape(state: LexerState, i: number): LexStep | undefined {
  if (state.command[i] !== "\\") return undefined;
  const next = state.command[i + 1];
  if (next === undefined) return { kind: "refuse", construct: "a trailing backslash" };
  state.word += next;
  state.started = true;
  return { kind: "advance", by: 2 };
}

/** Grouping, negation, comments and command substitutions are shell SYNTAX,
 * not word characters: left unmodelled they fold into the token text, so
 * `(rm -rf x)` and `! rm -rf x` present a first token of `(rm` / `!` that no
 * `Bash(rm*)` deny rule can match, while /bin/sh runs the `rm` regardless.
 * Refused by name, like every other construct this lexer cannot read. `!` and
 * `#` are only special at the START of a word -- `a!b` and `a#b` are ordinary
 * literals in sh, and refusing those would deny commands a grant plainly
 * covers. */
function refuseGroupingOrExpansion(state: LexerState, i: number): LexStep | undefined {
  const command = state.command;
  const char = command[i] as string;
  const next = command[i + 1];

  if (char === "(" || char === ")") return { kind: "refuse", construct: "a subshell `( ... )`" };
  if (char === "!" && !state.started) return { kind: "refuse", construct: "a `!` negation" };
  if (char === "#" && !state.started) return { kind: "refuse", construct: "a `#` comment" };
  if (char === "$" && next === "(") return { kind: "refuse", construct: "a command substitution `$(...)`" };
  if (char === "`") return { kind: "refuse", construct: "a backtick command substitution" };
  return undefined;
}

/** Redirection FORMS this lexer does not model: a process substitution, a
 * here-document, file-descriptor duplication and bash's `&>` shorthand are
 * each refused by name before the plain `<`/`>` handler can claim them. */
function refuseRedirectForm(state: LexerState, i: number): LexStep | undefined {
  const command = state.command;
  const char = command[i] as string;
  const next = command[i + 1];

  if ((char === "<" || char === ">") && next === "(") {
    return { kind: "refuse", construct: "a process substitution `<(...)` / `>(...)`" };
  }
  if (char === "<" && next === "<") return { kind: "refuse", construct: "a here-document `<<`" };
  if ((char === "<" || char === ">") && next === "&") {
    return { kind: "refuse", construct: "file-descriptor duplication (`2>&1`)" };
  }
  if (char === "&" && next === ">") return { kind: "refuse", construct: "the `&>` redirection form" };
  return undefined;
}

function lexDollar(state: LexerState, i: number): LexStep | undefined {
  if (state.command[i] !== "$") return undefined;
  state.opaque = true;
  state.word += "$";
  state.started = true;
  return { kind: "advance", by: 1 };
}

function skipWhitespace(state: LexerState, i: number): LexStep | undefined {
  const char = state.command[i] as string;
  if (char !== " " && char !== "\t" && char !== "\r") return undefined;
  flushWord(state);
  return { kind: "advance", by: 1 };
}

function lexLineSeparator(state: LexerState, i: number): LexStep | undefined {
  const char = state.command[i] as string;
  if (char !== "\n" && char !== ";") return undefined;
  const error = flushSegment(state, ";");
  if (error !== undefined) return { kind: "refuse", construct: error };
  return { kind: "advance", by: 1 };
}

function lexControlOperator(state: LexerState, i: number): LexStep | undefined {
  const command = state.command;
  const char = command[i] as string;
  const next = command[i + 1];

  if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
    const error = flushSegment(state, char === "&" ? "&&" : "||");
    if (error !== undefined) return { kind: "refuse", construct: error };
    return { kind: "advance", by: 2 };
  }
  if (char === "|" || char === "&") {
    const error = flushSegment(state, char);
    if (error !== undefined) return { kind: "refuse", construct: error };
    return { kind: "advance", by: 1 };
  }
  return undefined;
}

function lexRedirect(state: LexerState, i: number): LexStep | undefined {
  const command = state.command;
  const char = command[i] as string;
  if (char !== ">" && char !== "<") return undefined;

  // A bare fd digit belongs to the operator (`2>err.txt`), not to argv:
  // left in the token list it would have to satisfy an allow rule, and
  // `Bash(bun test *)` would refuse a command it plainly covers.
  if (/^\d$/.test(state.word)) {
    state.word = "";
    state.started = false;
  }
  flushWord(state);
  const appends = char === ">" && command[i + 1] === ">";
  state.pendingRedirect = appends ? ">>" : char;
  return { kind: "advance", by: appends ? 2 : 1 };
}

/** The dispatch table. ORDER IS BEHAVIOUR: the first handler that claims the
 * character wins, so the table must stay in the original guard chain's order —
 * quote/escape handling, structural refusals, redirect-form refusals, `$`,
 * whitespace, separators, plain redirection. */
const HANDLERS: readonly CharHandler[] = [
  lexSingleQuote,
  lexDoubleQuote,
  lexEscape,
  refuseGroupingOrExpansion,
  refuseRedirectForm,
  lexDollar,
  skipWhitespace,
  lexLineSeparator,
  lexControlOperator,
  lexRedirect,
];

/** Runs the first handler that claims the character at `i`, or `undefined`
 * when it is a plain word character (accumulated by `lexBashCommand`). */
function stepAt(state: LexerState, i: number): LexStep | undefined {
  for (const lex of HANDLERS) {
    const step = lex(state, i);
    if (step !== undefined) return step;
  }
  return undefined;
}
