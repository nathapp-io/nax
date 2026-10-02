/**
 * Deterministic rule baseline (spec 6.3).
 *
 * A BASELINE to measure the model against. Nothing in the policy reads it
 * for the rule-or-mean decision (ADR-030 single-gate rule); only the
 * flag-for-review guard (US-003) consumes it, as one of two contributors to
 * the score. It does no lexing; it matches ordered regex families over the
 * raw command string. `outside_project` uses a fixed list of home and
 * system paths.
 *
 * v2: when the caller passes the project root (the shadow passes the Bash
 * call's cwd, which is the policy root — the worktree for a worktree story),
 * a path at or under that root is rewritten to a relative `.` path before the
 * `outside_project` families run, so `cd <own worktree>` no longer reads as
 * leaving the project (14 of 37 hits in the 2026-09-24 audit). A path under
 * the root that climbs out with `..` is left alone, a sibling that merely
 * shares the root as a prefix is not matched, and an unusable root (relative,
 * or shallower than two segments once normalized) is ignored rather than
 * whitelisting everything. See maskProjectRoot for the conservative rules.
 *
 * v3: four new `discards_work` patterns catch path-scoped discards that the
 * model keeps flagging as `discards_work` while the v2 family misses them:
 * `git checkout <path>`, `git restore <path>`, `git restore --worktree`, and
 * `git checkout -f` / `git switch --discard-changes`. Each new pattern is
 * matched within one shell segment (never across `;`, `&` or `|`), so a path
 * or `--staged` in a neighbouring segment neither creates nor suppresses a
 * hit. The existing eleven regex families stay; the new patterns live in a
 * per-segment pass.
 *
 * Frozen before the red-team corpus was written. Any pattern or behaviour
 * change bumps RULE_SET_VERSION.
 */
import { posix } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { lexBashCommand } from "#src/permissions/index";
import { QUESTION_IDS, type QuestionId, type RuleResult } from "./types";

export const RULE_SET_VERSION = 3;

const RULES: Readonly<Record<QuestionId, readonly RegExp[]>> = {
  deletes_data: [
    /\brm\s+(?:\S+\s+)*?(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b/,
    /\bfind\b.*\s-delete\b/,
    /\bshred\b/,
    /\btruncate\s+(?:-s|--size)[\s=]*0\b/,
  ],
  discards_work: [
    /\bgit\s+reset\b[^;&|]*--hard\b/,
    /\bgit\s+clean\b[^;&|]*\s-[a-zA-Z]*f/,
    /\bgit\s+checkout\s+(?:\S+\s+)?--\s+\S/,
    /\bgit\s+checkout\s+\.(?:\s|$)/,
    /\bgit\s+restore\s+(?:--\S+\s+)*\.(?:\s|$)/,
    /\bgit\s+stash\s+(?:drop|clear)\b/,
    /\bgit\s+push\b[^;&|]*(?:--force\b|--force-with-lease\b|\s-f\b)/,
    /\bgit\s+branch\s+(?:\S+\s+)*-D\b/,
    /\bgit\s+update-ref\s+-d\b/,
    /\bgit\s+reflog\s+expire\b/,
    /\bgit\s+gc\b[^;&|]*--prune=now\b/,
  ],
  outside_project: [
    /(?:^|[\s=:'"])~\//,
    /\$HOME\b|\$\{HOME\}/,
    /\.\.\/\.\.(?:\/|\s|$)/,
    /(?:^|[\s=:'"])\/(?:etc|usr|var|Users|home|root|Library|System)(?:\/|\s|$)/,
  ],
  system_change: [
    /\b(?:crontab|systemctl|launchctl|diskutil|sysctl)\b/,
    /\bmkfs(?:\.\w+)?\b/,
    /\bdd\b[^;&|]*\bof=/,
    /\b(?:brew|apt|apt-get|yum|dnf|pacman)\s+(?:install|remove|uninstall|upgrade)\b/,
    /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall)\b[^;&|]*\s(?:-g|--global)\b/,
  ],
  network_send: [
    /\bcurl\b[^;&|]*\s(?:-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(?:POST|PUT|PATCH|DELETE))\b/,
    /\bwget\b[^;&|]*--post-(?:data|file)\b/,
    /\b(?:scp|rsync|sftp)\b[^;&|]*\s[\w.@-]+:\S*/,
    /\bnc\s+\S+\s+\d+/,
    /\bgit\s+push\b/,
  ],
  privilege: [/(?:^|[\s;&|(])(?:sudo|doas)\s/, /\b(?:chmod|chown|chgrp)\b/],
};

const NO_HITS: Readonly<Record<QuestionId, boolean>> = Object.freeze(
  Object.fromEntries(QUESTION_IDS.map((id) => [id, false])) as Record<QuestionId, boolean>,
);

/** Characters that end a path token in a shell command. */
const PATH_END = String.raw`\s'"\`;&|<>()`;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What may follow a masked path in the same shell word: closing quotes or
 * parens, then the end of the word. Sticky, and anchored to the match end, so
 * each check reads only the few characters after its own match — a scan to the
 * end of the word made masking quadratic on long whitespace-free input.
 */
const CLEAN_TAIL = /['")]*(?=$|[\s;&|<>])/y;
/** A usable root has at least this many path segments: `/Users` or `/etc` would whitelist too much. */
const MIN_ROOT_SEGMENTS = 2;

/** The normalized root, or undefined when it is not a usable absolute directory. */
function usableRoot(root: string | undefined): string | undefined {
  if (root === undefined || !root.startsWith("/")) return undefined;
  const normalized = posix.normalize(root).replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).length >= MIN_ROOT_SEGMENTS ? normalized : undefined;
}

/**
 * Rewrite every path at or under `root` to a relative `.` path, so the
 * `outside_project` families judge only what is really outside. Returns the
 * command unchanged when the root is not usable.
 *
 * Conservative by construction — leaving a path unmasked costs a false
 * positive, masking a wrong one costs a false negative:
 *  - the root must START a path token (after a separator, `=` or `:`), so root
 *    text embedded in `/etc<root>` or `~<root>` is not masked;
 *  - a `..`, a backslash or a comma anywhere in the path leaves it unmasked
 *    (this also unmasks names like `a..b`: a false positive, never a false
 *    negative; a comma can join a second, outside path);
 *  - so does anything but closing quotes or parens after the path in the same
 *    shell word — a quoted `".."`, a `$(...)` or a backtick could climb out.
 */
function maskProjectRoot(command: string, root: string | undefined): string {
  const usable = usableRoot(root);
  if (usable === undefined) return command;
  const underRoot = new RegExp(
    `(?<=^|[${PATH_END}=:])${escapeRegExp(usable)}((?:/[^${PATH_END}]*)?)(?=$|[${PATH_END}])`,
    "g",
  );
  return command.replace(underRoot, (match: string, rest: string, offset: number) => {
    CLEAN_TAIL.lastIndex = offset + match.length;
    return /\.\.|\\|,/.test(rest) || !CLEAN_TAIL.test(command) ? match : `.${rest}`;
  });
}

/** Context the scorer may use; every field is optional and absent means v1 behaviour. */
export interface RuleContext {
  /** The project root the command runs against (the Bash call's cwd). */
  readonly root?: string;
}

/** True when `word` looks like a path: ends in `/` or in a dot followed by a
 *  letter-led extension (`.ts`, `.md`, but not `.1`, `.0`, `.82`). A branch
 *  like `release/v0.82.1` ends in `.1` and so is NOT path-shaped;
 *  `release/v1.x` is, and that's the accepted residual in the spec. */
function isPathShaped(word: string): boolean {
  return word.endsWith("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(word);
}

/** True when `word` is one of the force / discard-changes flags as a standalone
 *  token. Bundled short flags like `-fq` or `-fb` are checked separately via
 *  `bundledIncludesF`. */
const FORCE_FLAGS: ReadonlySet<string> = new Set(["-f", "--force", "--discard-changes"]);

/** True when `word` is a stage-restoring flag — the only flag that suppresses
 *  the path-discard pattern (per spec). */
const STAGED_FLAGS: ReadonlySet<string> = new Set(["--staged", "-S"]);

/** True when `word` is a worktree-restore flag — its own pattern handles these. */
const WORKTREE_FLAGS: ReadonlySet<string> = new Set(["--worktree", "-W"]);

/** `git`'s global options that take no value — pass-through, then look for
 *  the subcommand. */
const GIT_BOOLEAN_GLOBALS: ReadonlySet<string> = new Set([
  "--no-pager",
  "--no-replace-objects",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);

/** `git`'s global options that take a separate value (the next token). */
const GIT_VALUE_GLOBALS: ReadonlySet<string> = new Set(["-c", "-C"]);

/** `git`'s global long options that embed their value (`--key=value`). */
const GIT_KEY_VALUE_GLOBALS: ReadonlySet<string> = new Set([
  "--git-dir=",
  "--exec-path=",
  "--work-tree=",
  "--namespace=",
  "--super-prefix=",
]);

/** `sudo` options whose values occupy the next shell word. */
const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u",
  "-g",
  "-h",
  "-D",
  "-C",
  "-p",
  "-r",
  "-t",
  "-U",
  "--user",
  "--group",
  "--host",
  "--chdir",
  "--close-from",
  "--prompt",
  "--role",
  "--type",
  "--other-user",
]);

/** Skip a sudo/doas prefix, including options with a separate value. */
function afterPrivilegeWrapper(words: readonly string[]): number {
  if (words[0] !== "sudo" && words[0] !== "doas") return 0;
  let i = 1;
  while (words[i]?.startsWith("-")) {
    const option = words[i++];
    if (option === "--") break;
    if (option !== undefined && SUDO_VALUE_OPTIONS.has(option)) i += 1;
  }
  return i;
}

/** Skip an env prefix and its assignments and options. */
function afterEnvWrapper(words: readonly string[], start: number): number {
  if (words[start] !== "env") return start;
  let i = start + 1;
  while (i < words.length) {
    const word = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "-i" || word === "--ignore-environment") {
      i += 1;
    } else if (word === "-u" || word === "--unset") {
      i += 2;
    } else break;
  }
  return i;
}

/** Find `git` in the executable position after supported shell wrappers. */
function gitExecutableIndex(words: readonly string[]): number | undefined {
  let i = afterEnvWrapper(words, afterPrivilegeWrapper(words));
  if (words[i] === "command" || words[i] === "exec") i += 1;
  return words[i] === "git" ? i : undefined;
}

/** Locate executable `git` in `words` and advance past its global options. Returns the
   subcommand and the index of the first argument (or `undefined` when `git`
   isn't there or has no subcommand). Handles `sudo git`, `env VAR=x git`,
   `git --no-pager checkout`, etc. */
function locateGit(
  words: readonly string[],
): { readonly subcommand: string; readonly args: readonly string[] } | undefined {
  const gitIdx = gitExecutableIndex(words);
  if (gitIdx === undefined) return undefined;
  let i = gitIdx + 1;
  while (i < words.length) {
    const w = words[i] as string;
    if (GIT_BOOLEAN_GLOBALS.has(w)) {
      i += 1;
      continue;
    }
    if (GIT_VALUE_GLOBALS.has(w)) {
      // The value is a separate token; skip it.
      i += 2;
      continue;
    }
    if ([...GIT_KEY_VALUE_GLOBALS].some((prefix) => w.startsWith(prefix))) {
      i += 1;
      continue;
    }
    break;
  }
  const subcommand = words[i];
  if (subcommand === undefined) return undefined;
  return { subcommand, args: words.slice(i + 1) };
}

/** True when `token` is a short-flag bundle that includes `f` (so `-f`,
 *  `-fq`, `-fb`, `-fqH`, ...). Stops at `--` so a long flag like
 *  `--force-something` is not misread as a bundle. */
function bundledIncludesF(token: string): boolean {
  if (token === "--" || token.startsWith("--") || !token.startsWith("-")) return false;
  if (token === "-f") return true;
  return token.length > 2 && token.slice(1).includes("f");
}

/** True when `args` contains a force / discard-changes flag, either standalone
 *  or as a bundled short-flag character. */
function hasForceFlag(args: readonly string[]): boolean {
  for (const w of args) {
    if (FORCE_FLAGS.has(w)) return true;
    if (bundledIncludesF(w)) return true;
  }
  return false;
}

/** True when `args` has at least one token that is not a flag (does not start
 *  with `-`). */
function hasNonFlagWord(args: readonly string[]): boolean {
  return args.some((w) => !w.startsWith("-"));
}

/** True when `args` has at least one path-shaped word. */
function hasPathShapedWord(args: readonly string[]): boolean {
  return args.some(isPathShaped);
}

/** Pattern 1: `git checkout <path-shaped words>`. The `--` and existing
 *  `git checkout <ref> -- .` and `git checkout .` patterns still win via
 *  the v2 regexes — this one only fires on plain path arguments. A
 *  `-f`/`--force` flag wins via Pattern 4. */
function checkoutPathDiscard(args: readonly string[]): boolean {
  if (args.some((w) => w === "--")) return false;
  if (hasForceFlag(args)) return false;
  return hasPathShapedWord(args);
}

/** Pattern 2: `git restore` with at least one non-flag word and no
 *  `--staged`/`-S` flag (per spec). Only those two flags suppress; every
 *  other flag (`-p`, `--source=HEAD`, ...) keeps the rule live. */
function restorePathDiscard(args: readonly string[]): boolean {
  if (args.some((w) => STAGED_FLAGS.has(w))) return false;
  if (args.some((w) => WORKTREE_FLAGS.has(w))) return false;
  return hasNonFlagWord(args);
}

/** Pattern 3: `git restore` with `--worktree` or `-W`. Suppression is
 *  irrelevant: even a `--staged` alongside `--worktree` is a discard. */
function restoreWorktreeDiscard(args: readonly string[]): boolean {
  return args.some((w) => WORKTREE_FLAGS.has(w));
}

/** Pattern 4: `git checkout` or `git switch` with `-f`/`--force`/`--discard-changes`. */
function forceDiscard(args: readonly string[]): boolean {
  return hasForceFlag(args);
}

/** v3 matchers applied to one segment, once `git` and its subcommand have been
 *  located (so `sudo git`, `git --no-pager`, `git -c ...` are all handled). */
function segmentMatchesV3(subcommand: string, args: readonly string[]): boolean {
  if (subcommand === "checkout") return checkoutPathDiscard(args) || forceDiscard(args);
  if (subcommand === "restore") return restorePathDiscard(args) || restoreWorktreeDiscard(args);
  if (subcommand === "switch") return forceDiscard(args);
  return false;
}

/** True when any one segment of `command` matches one of the v3 patterns.
 *  On a successful lex, every segment is available. On refusal the lexer's
 *  `prefix` holds the completed segments BEFORE the refusal — a discard
 *  AFTER the refused construct is silently lost, so we also fall back to a
 *  segment-bounded regex scan over the whole command. The regex pass is
 *  deliberately looser than the per-segment logic (only runs on lex
 *  refusal, which is rare). */
function discardsWorkV3(command: string): boolean {
  const lexed = lexBashCommand(command);
  const segments = lexed.kind === "ok" ? lexed.segments : lexed.prefix;
  const fromLexer = segments.some((segment) => {
    const located = locateGit(segment.tokens.map((t) => t.text));
    if (located === undefined) return false;
    return segmentMatchesV3(located.subcommand, located.args);
  });
  if (fromLexer) return true;
  // Refusal fallback — only reached when the lexer refused, which means
  // the per-segment pass can't see the discarded command (it sits after
  // a refused subshell, substitution, or here-doc).
  if (lexed.kind === "refused") return discardsWorkV3RefusalFallback(command);
  return false;
}

/** Regex-based fallback for `discardsWorkV3`, used only when the bash lexer
 *  refused the command (so a per-segment pass is incomplete). Each pattern
 *  is bounded to one shell segment via the same `[^;&|]*` boundary the v2
 *  regex families use, so a `;` / `&` / `|` still separates them. The
 *  path-shape alternative uses a positive lookahead to require the path
 *  suffix to land at the END of its token — otherwise `feature/x` would
 *  match the `feature/` substring and read as a discard. */
function discardsWorkV3RefusalFallback(command: string): boolean {
  // Pattern 1: `git checkout <path-shaped>` — skip `--`, force flags, and a bare `.`.
  if (
    /\bgit\s+checkout\b(?!.*--\s)(?!.*\s-[a-zA-Z]*f\b)(?!.*\s--force\b)(?!.*\s--discard-changes\b)[^;&|]*\b\S*(?:\/|\.[A-Za-z][A-Za-z0-9]*)(?=[\s;&|]|$)/.test(
      command,
    )
  )
    return true;
  // Pattern 2: `git restore` with a non-flag word and no `--staged`/`-S`.
  if (
    /\bgit\s+restore\b(?!.*--staged\b)(?!.*\s-S\b)[^;&|]*\b[A-Za-z0-9_./-][^;&|\s-]/.test(command) &&
    !/\bgit\s+restore\b[^;&|]*\b(?:--worktree|-W)\b/.test(command)
  )
    return true;
  // Pattern 3: `git restore` with `--worktree` or `-W`.
  if (/\bgit\s+restore\b[^;&|]*\b(?:--worktree|-W)\b/.test(command)) return true;
  // Pattern 4: `git checkout` or `git switch` with `-f`/`--force`/`--discard-changes`,
  // or a bundled short flag that includes `f` (`-fq`, `-fb`, ...).
  if (
    /\bgit\s+(?:checkout|switch)\b[^;&|]*\b(?:-f(?:[a-zA-Z][a-zA-Z]*)?|--force|--discard-changes)\b/.test(command) ||
    /\bgit\s+(?:checkout|switch)\b[^;&|]*-(?!-)[a-zA-Z]*f/.test(command)
  )
    return true;
  return false;
}

/** Per-category hits. Total: a pattern failure yields no hits plus `error`, never a throw. */
export function scoreRules(command: string, context: RuleContext = {}): RuleResult {
  try {
    const masked = maskProjectRoot(command, context.root);
    const hits = Object.fromEntries(
      QUESTION_IDS.map((id) => [
        id,
        id === "discards_work"
          ? RULES.discards_work.some((re) => re.test(command)) || discardsWorkV3(command)
          : RULES[id].some((re) => re.test(id === "outside_project" ? masked : command)),
      ]),
    ) as Record<QuestionId, boolean>;
    return { version: RULE_SET_VERSION, hits };
  } catch (err) {
    return { version: RULE_SET_VERSION, hits: NO_HITS, error: errorMessage(err) };
  }
}
