/**
 * Deterministic rule baseline (spec 6.3).
 *
 * A BASELINE to measure the model against, never a gate: nothing in the
 * policy reads it (single-gate rule, ADR-030). It does no lexing; it matches
 * ordered regex families over the raw command string. `outside_project` uses a
 * fixed list of home and system paths.
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
import { lexBashCommand } from "@/permissions";
import { errorMessage } from "@/utils/errors";
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

/** True when `word` is a force / discard-changes flag. */
const FORCE_FLAGS: ReadonlySet<string> = new Set(["-f", "--force", "--discard-changes"]);

/** True when `word` is a stage-restoring flag — suppresses the path-discard pattern. */
const STAGED_FLAGS: ReadonlySet<string> = new Set(["--staged", "-S"]);

/** True when `word` is a worktree-restore flag — its own pattern handles these. */
const WORKTREE_FLAGS: ReadonlySet<string> = new Set(["--worktree", "-W"]);

/** Pattern 1: `git checkout <path-shaped words>`. The `--` and existing
 *  `git checkout <ref> -- .` and `git checkout .` patterns still win via
 *  the v2 regexes — this one only fires on plain path arguments. A
 *  `-f`/`--force` flag wins via Pattern 4. */
function checkoutPathDiscard(words: readonly string[]): boolean {
  if (words[0] !== "git" || words[1] !== "checkout") return false;
  const rest = words.slice(2);
  if (rest.length === 0) return false;
  if (rest.some((w) => w === "--" || FORCE_FLAGS.has(w))) return false;
  if (rest.some((w) => w.startsWith("-"))) return false;
  return rest.some(isPathShaped);
}

/** Pattern 2: `git restore <path-shaped words>` with no `--staged`/`-S`. */
function restorePathDiscard(words: readonly string[]): boolean {
  if (words[0] !== "git" || words[1] !== "restore") return false;
  const rest = words.slice(2);
  if (rest.length === 0) return false;
  if (rest.some((w) => STAGED_FLAGS.has(w))) return false;
  if (rest.some((w) => WORKTREE_FLAGS.has(w))) return false;
  if (rest.some((w) => w.startsWith("-"))) return false;
  return rest.some(isPathShaped);
}

/** Pattern 3: `git restore` with `--worktree` or `-W`. Suppression is
 *  irrelevant: even a `--staged` alongside `--worktree` is a discard. */
function restoreWorktreeDiscard(words: readonly string[]): boolean {
  if (words[0] !== "git" || words[1] !== "restore") return false;
  return words.slice(2).some((w) => WORKTREE_FLAGS.has(w));
}

/** Pattern 4: `git checkout` or `git switch` with `-f`/`--force`/`--discard-changes`. */
function forceDiscard(words: readonly string[]): boolean {
  if (words[0] !== "git") return false;
  if (words[1] !== "checkout" && words[1] !== "switch") return false;
  return words.slice(2).some((w) => FORCE_FLAGS.has(w));
}

/** True when any one segment of `command` matches one of the v3 patterns.
 *  The lexer is safe-by-refusal: on refusal its `prefix` holds the
 *  completed segments, which is what we want — an unreadable later
 *  construct must not hide an earlier hit. */
function discardsWorkV3(command: string): boolean {
  const lexed = lexBashCommand(command);
  const segments = lexed.kind === "ok" ? lexed.segments : lexed.prefix;
  return segments.some((segment) => {
    const words = segment.tokens.map((t) => t.text);
    return (
      checkoutPathDiscard(words) || restorePathDiscard(words) || restoreWorktreeDiscard(words) || forceDiscard(words)
    );
  });
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
