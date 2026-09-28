/**
 * Observable literal-temp-write signal (US-005).
 *
 * Records, never decides. True when a command writes to a literal `/tmp` or
 * `/private/tmp` path outside nax's own temp trees — the shared `/tmp/nax/`
 * parent of every run root and the per-user `/tmp/nax-<uid>` fallback — so the
 * frequency of that scratch-write habit is measurable. The caller only stores
 * the boolean on the shadow row: it is not a `QuestionId`, not in
 * `rules.hits`, and changes no verdict.
 *
 * Total by construction: `lexBashCommand` is safe-by-refusal and does no I/O,
 * so a refused lex scans its lexable prefix instead of throwing.
 */
import { posix } from "node:path";
import { type BashSegment, type BashToken, lexBashCommand } from "@/permissions";

/** The literal temp roots a flagged write must land in. */
const TEMP_ROOTS = ["/tmp", "/private/tmp"] as const;

/** nax's shared temp parent, a directory directly under a temp root. */
const NAX_PARENT_SEGMENT = "nax";
/** nax's per-user fallback parent, whose `<uid>` keeps it outside the shared parent's subtree. */
const NAX_FALLBACK_SEGMENT = "nax-";

/** First tokens whose later non-flag words are all write targets. */
const ARG_TARGET_COMMANDS: ReadonlySet<string> = new Set(["tee", "touch", "mkdir"]);
/** First tokens whose LAST non-flag word is the write target. */
const LAST_TARGET_COMMANDS: ReadonlySet<string> = new Set(["cp", "mv"]);

/** One candidate write target, with the opacity the lexer recorded for it. */
type Target = BashToken;

/** Every write target of one segment, in the order the lexer saw them. */
function writeTargets(segment: BashSegment): readonly Target[] {
  const targets: Target[] = [];
  for (const redirect of segment.redirects) {
    // Input redirects (`<`, and the refused `<<` / `<<<`) read; they do not write.
    if (redirect.operator.startsWith("<")) continue;
    targets.push({ text: redirect.target, opaque: redirect.opaque });
  }
  const first = segment.tokens[0]?.text;
  if (first !== undefined && ARG_TARGET_COMMANDS.has(first)) {
    for (const token of segment.tokens.slice(1)) {
      if (!token.text.startsWith("-")) targets.push(token);
    }
  } else if (first !== undefined && LAST_TARGET_COMMANDS.has(first)) {
    const words = segment.tokens.slice(1).filter((token) => !token.text.startsWith("-"));
    const last = words[words.length - 1];
    if (last !== undefined) targets.push(last);
  }
  return targets;
}

/**
 * The absolute path `target` names under `frame`, or undefined when it cannot
 * be read literally: an opaque (expansion-bearing) word, a `~` home reference,
 * or a relative word with no known frame.
 */
function resolveTarget(target: Target, frame: string | undefined): string | undefined {
  if (target.opaque || target.text.startsWith("~")) return undefined;
  if (target.text.startsWith("/")) return posix.normalize(target.text);
  return frame === undefined ? undefined : posix.normalize(posix.join(frame, target.text));
}

/** True when `path` lies in nax's own temp tree under `root`, never counted. */
function isNaxTempTree(path: string, root: string): boolean {
  // A path-boundary prefix, not a string prefix: `/tmp/naxfoo` is a different
  // directory from `/tmp/nax` and stays counted. The shared parent is checked
  // with its trailing separator because it is a directory of run roots; the
  // fallback is a whole name prefix, `<uid>` and all.
  return path.startsWith(`${root}/${NAX_PARENT_SEGMENT}/`) || path.startsWith(`${root}/${NAX_FALLBACK_SEGMENT}`);
}

/** True when `path` is a temp root or lies under one, but not under nax's own subtree. */
function isTmpPath(path: string): boolean {
  for (const root of TEMP_ROOTS) {
    if (path !== root && !path.startsWith(`${root}/`)) continue;
    return !isNaxTempTree(path, root);
  }
  return false;
}

/** The frame a `cd <target>` segment leaves behind; otherwise the frame unchanged. */
function frameAfter(segment: BashSegment, frame: string | undefined): string | undefined {
  const [command, target] = segment.tokens;
  if (command?.text !== "cd" || target === undefined) return frame;
  return resolveTarget(target, frame) ?? frame;
}

/** True when the command writes to a literal /tmp or /private/tmp path outside nax's own dirs. */
export function detectTmpWrite(command: string, cwd?: string): boolean {
  const lexed = lexBashCommand(command);
  // A refused lex still exposes the part it read: the gate refuses on the
  // unreadable construct, not on the prefix before it.
  const segments = lexed.kind === "ok" ? lexed.segments : lexed.prefix;
  let frame = cwd === undefined ? undefined : posix.normalize(cwd);
  for (const segment of segments) {
    for (const target of writeTargets(segment)) {
      const resolved = resolveTarget(target, frame);
      if (resolved !== undefined && isTmpPath(resolved)) return true;
    }
    frame = frameAfter(segment, frame);
  }
  return false;
}
