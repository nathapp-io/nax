/**
 * Conservative temp-only predicate (US-002).
 *
 * Returns true when every path-like token and redirect target in `command`
 * names a temp path, a `$TMPDIR` expansion that resolves to one, a path
 * under `cwd`, or `/dev/null` / `/dev/stdout` / `/dev/stderr` — AND at
 * least one of them is a temp path. Two unjudgeable shapes force `false`:
 * an attached short-option value containing `/` (e.g. `-C/etc`) and a URL
 * (any token containing `://`).
 *
 * The frame (working-directory proxy) advances through `cd` segments the
 * same way `detectTmpWrite` does, with one difference: when a `cd` target is
 * an opaque word (`$D`) or a `~` reference — anything the lexer did not
 * literalize — the frame becomes unknown, and any later relative path-like
 * token fails the predicate. A refused lex or an undefined `cwd` also
 * fails it.
 *
 * This is a no-ask filter; a `false` return is information only, never a
 * decision.
 */
import { posix } from "node:path";
import { type BashSegment, lexBashCommand } from "@/permissions";

/** The literal temp roots a temp path must land in. */
const TEMP_ROOTS = ["/tmp", "/private/tmp"] as const;

/** The two opaque variable names accepted as temp path expansions. */
const TMPDIR_BARE = "$TMPDIR";
const TMPDIR_BRACE = "$" + "{TMPDIR}";

/** The three /dev entries allowed as safe redirect targets. */
const DEV_ALLOWLIST = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** One candidate path-like token or redirect target, with its opaqueness. */
interface PathToken {
  readonly text: string;
  readonly opaque: boolean;
}

/** Outcome of classifying one path-like token or redirect target. */
type Verdict = "temp" | "allowed" | "refuse";

/** True when `token` looks like a path the predicate must judge:
 * contains a `/`, equals `.` or `..`, or starts with `~`. */
function isPathLike(token: string): boolean {
  return token.includes("/") || token === "." || token === ".." || token.startsWith("~");
}

/** True when `token` is a shell option flag the predicate must skip past to
 * find a real target: starts with `-` but is not itself path-like and has no
 * `--flag=value` to extract. `cd -P /tmp` has `-P` as the option and `/tmp`
 * as the target. */
function isOptionFlag(token: string): boolean {
  if (!token.startsWith("-")) return false;
  if (isPathLike(token)) return false;
  if (flagValue(token) !== undefined) return false;
  return true;
}

/** The judged value of a `--flag=value` token, or undefined when `token` is
 * not of that form. Anything else is judged as-is. */
function flagValue(token: string): string | undefined {
  if (!token.startsWith("--")) return undefined;
  const eq = token.indexOf("=");
  return eq === -1 ? undefined : token.slice(eq + 1);
}

/** True when `path` is or lies under one of the literal temp roots. */
function isTempPath(path: string): boolean {
  return TEMP_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/** True when `path` equals `cwd` or lies under it. */
function isUnderCwd(path: string, cwd: string): boolean {
  return path === cwd || path.startsWith(`${cwd}/`);
}

/** True when `text` contains a `..` path segment anywhere — used to refuse
 * `$TMPDIR/../x` shapes that would climb out of the temp root at runtime. */
function hasParentSegment(text: string): boolean {
  return text.split("/").includes("..");
}

/** True when `token` is exactly `$TMPDIR` / `${TMPDIR}` or one of them
 * followed by `/` and a remainder with no `..` segment. False when it is a
 * different opaque word, undefined when the token is not opaque. */
function isTmpDirExpansion(token: PathToken): boolean | undefined {
  if (!token.opaque) return undefined;
  if (token.text === TMPDIR_BARE || token.text === TMPDIR_BRACE) return true;
  if (token.text.startsWith(`${TMPDIR_BARE}/`)) {
    return !hasParentSegment(token.text.slice(TMPDIR_BARE.length + 1));
  }
  if (token.text.startsWith(`${TMPDIR_BRACE}/`)) {
    return !hasParentSegment(token.text.slice(TMPDIR_BRACE.length + 1));
  }
  return false;
}

/** True when `token` is an attached short option value the predicate cannot
 * split (`-C/etc`), or a `--flag=value` form. The value, when present, is
 * classified recursively. */
function shortOptionVerdict(token: PathToken, frame: string | undefined, cwd: string): Verdict | undefined {
  if (!token.text.startsWith("-") || !token.text.includes("/")) return undefined;
  if (token.text.startsWith("--")) {
    const value = flagValue(token.text);
    if (value !== undefined) return classify({ text: value, opaque: token.opaque }, frame, cwd);
  }
  return "refuse";
}

/** True when `token` is an unjudgeable shape (URL, `~` path, opaque word
 * other than `$TMPDIR`). Callers must check `isTmpDirExpansion` first. */
function unjudgeable(token: PathToken): boolean {
  if (token.text.includes("://")) return true;
  if (token.text.startsWith("~")) return true;
  return token.opaque;
}

/** Classifies a literal (non-opaque, non-short-option, non-flag) absolute or
 * relative path against the temp-root, /dev allowlist, cwd, and frame. */
function classifyLiteral(token: PathToken, frame: string | undefined, cwd: string): Verdict {
  if (token.text.startsWith("/")) {
    const normalized = posix.normalize(token.text);
    if (isTempPath(normalized)) return "temp";
    if (DEV_ALLOWLIST.has(normalized)) return "allowed";
    return isUnderCwd(normalized, cwd) ? "allowed" : "refuse";
  }
  if (frame === undefined) return "refuse";
  const resolved = posix.normalize(posix.join(frame, token.text));
  if (isTempPath(resolved)) return "temp";
  return isUnderCwd(resolved, cwd) ? "allowed" : "refuse";
}

/** Classifies one path-like `token` (or redirect target) against the rules.
 * Returns `temp` when the path is a temp path (the credit), `allowed` when
 * it is some other safe value (cwd, /dev, `$TMPDIR` expansion), and `refuse`
 * when it cannot be judged or falls outside the safe set. */
function classify(token: PathToken, frame: string | undefined, cwd: string): Verdict {
  const short = shortOptionVerdict(token, frame, cwd);
  if (short !== undefined) return short;
  const tmpdir = isTmpDirExpansion(token);
  if (tmpdir !== undefined) return tmpdir ? "temp" : "refuse";
  if (unjudgeable(token)) return "refuse";
  return classifyLiteral(token, frame, cwd);
}

/** The frame a `cd <target>` segment leaves behind. When the cd target is
 * not a literal, cwd-rooted, or $TMPDIR path the frame is lost. Any option
 * flags the user wrote before the target (`-P`, `-L`, `--`) are skipped, so
 * `cd -P $D` classifies `$D` (opaque, unresolvable) and clears the frame
 * instead of joining a synthetic one from the option word. */
function frameAfter(segment: BashSegment, frame: string | undefined, cwd: string): string | undefined {
  const [command, ...rest] = segment.tokens;
  if (command?.text !== "cd") return frame;
  const target = rest.find((token) => !isOptionFlag(token.text));
  if (target === undefined) return frame;
  if (classify({ text: target.text, opaque: target.opaque }, frame, cwd) === "refuse") return undefined;
  if (target.text.startsWith("/")) return posix.normalize(target.text);
  return frame === undefined ? undefined : posix.normalize(posix.join(frame, target.text));
}

/** Classifies every path-like token and redirect target in one segment.
 * Returns `true` when any verdict was `temp` (so far). Returns `false` when
 * any verdict was `refuse`; the caller then returns false from the whole
 * predicate. A `--flag=value` token is judged by its VALUE — the flag name
 * hides any `/`, `.`, `..`, or `~` the value contains, so the whole token
 * would not look path-like on its own. */
function classifySegment(
  segment: BashSegment,
  frame: string | undefined,
  cwd: string,
): { readonly hasTempPath: boolean; readonly refused: boolean } {
  let hasTempPath = false;
  for (const redirect of segment.redirects) {
    const verdict = classify({ text: redirect.target, opaque: redirect.opaque }, frame, cwd);
    if (verdict === "refuse") return { hasTempPath, refused: true };
    if (verdict === "temp") hasTempPath = true;
  }
  for (const token of segment.tokens) {
    const value = flagValue(token.text);
    const judgedText = value ?? token.text;
    if (!isPathLike(judgedText)) continue;
    const verdict = classify({ text: judgedText, opaque: token.opaque }, frame, cwd);
    if (verdict === "refuse") return { hasTempPath, refused: true };
    if (verdict === "temp") hasTempPath = true;
  }
  return { hasTempPath, refused: false };
}

/** True when the command touches only temp paths, `$TMPDIR`, paths under
 * `cwd`, and the three allowlisted /dev entries — and at least one of those
 * paths is a literal temp root. A refused lex, an undefined `cwd`, or any
 * unjudgeable token (URL, attached short option, opaque non-`$TMPDIR`, or a
 * relative path after an unresolvable cd) returns false. */
export function isTempOnly(command: string, cwd: string | undefined): boolean {
  if (cwd === undefined || cwd === "") return false;
  const lexed = lexBashCommand(command);
  if (lexed.kind === "refused") return false;

  const normalizedCwd = posix.normalize(cwd);
  if (normalizedCwd === "" || normalizedCwd === ".") return false;
  let frame: string | undefined = normalizedCwd;
  let hasTempPath = false;

  for (const segment of lexed.segments) {
    const outcome = classifySegment(segment, frame, normalizedCwd);
    if (outcome.refused) return false;
    if (outcome.hasTempPath) hasTempPath = true;
    frame = frameAfter(segment, frame, normalizedCwd);
  }

  return hasTempPath;
}
