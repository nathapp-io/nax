/**
 * The `raw` bash mode screen (ADR-030).
 *
 * `raw` is pass-through: no per-segment grant matching, no root containment,
 * and — unlike `checkBashCommand` — a command the lexer CANNOT read is ALLOWED
 * rather than refused. That inversion is the whole point of the mode.
 *
 * The one thing this screen still does is catch a naive mistake: if the lexer
 * CAN parse the command and a segment names or redirects into a path the
 * host's owned-paths policy owns (for nax: `.nax/config.json`,
 * `.nax/mono/*\/config.json`, `.nax/features/**\/prd.json`, the root
 * queue-control files), the command is denied. Which paths those are, and how
 * a refusal reads, is the `OwnedPathsPolicy` port's decision (S3-2); this
 * screen only supplies the per-frame candidates.
 *
 * ADVISORY BY CONSTRUCTION. A command using substitution is not parsed and
 * therefore is not screened at all: `sh -c "$(echo rm) .nax/features/f/prd.json"`
 * passes straight through. This is a mistake-catcher, not a boundary, and it
 * must never grow into a general gate — gating lives in policy, once
 * (`src/tools/bash.ts:14-19`). The ONE deliberate exception is the
 * whole-filesystem `find` refusal below: a COST guard (a root-wide walk runs
 * into the 300s Bash timeout), not a containment boundary.
 *
 * A parseable `cd` moves every LATER segment's frame of reference, exactly as
 * it does for `checkBashCommand`, so this screen tracks it too via the shared
 * `cdTargetsFor` / `nextWorkingDirectories` (bash-cwd.ts) -- otherwise
 * `cd child && echo ABORT > ../.queue.txt` would be screened against the
 * wrong directory and let a run-control write through unnoticed.
 *
 * THE CRITICAL ASYMMETRY, read this before touching the `cd` handling below:
 * where `checkBashCommand` DENIES a `cd` it cannot model (an option-shaped
 * target, an opaque one, one that fails to resolve), this screen must NOT --
 * raw enforces no containment by definition, and denying there would silently
 * re-gate raw into a containment gate through the back door of `cd` modelling.
 * A `cd` that leaves the root (`cd ../outside`) is the common case:
 * `resolvePath` is `resolveWithin(root, ...)`, which returns `null` for
 * anything outside the root, so it yields no trackable frame at all. Do not
 * "fix" the unmodelled cases into a denial.
 *
 * But failing open on the `cd` is NOT the same as abandoning the screen. An
 * earlier revision returned `allow` for the WHOLE command on an unmodelled
 * `cd`, which meant a single everyday idiom disabled the screen for every
 * later segment: `cd - ; echo ABORT > .queue.txt` wrote the run-control file
 * unscreened -- strictly worse than the initialPath-pinned code this tracking
 * replaced, which caught it by accident. So an unmodelled `cd` leaves the
 * frame set at its LAST KNOWN value and screening continues. The frame is
 * then an estimate, and the screen may refuse a write that the shell would
 * actually have placed somewhere harmless. That is the correct trade for an
 * advisory mistake-catcher: a false refusal costs one turn and says why,
 * while a false pass can abort the run.
 */
import { relative, resolve, sep } from "node:path";
import { realOrRaw } from "#src/internal/realpath";
import { type BashToken, lexBashCommand } from "#src/permissions/index";
import { cdTargetsFor, nextWorkingDirectories } from "./bash-cwd.ts";
import type { OwnedBashCandidate, OwnedPathsPolicy } from "./owned-paths.ts";
import type { BashCheck } from "./policy-bash.ts";

export interface RawScreenArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The shell's initial working directory. */
  readonly initialPath: string;
  /** Resolves a candidate from an effective shell working directory. */
  readonly resolvePath: (candidate: string, cwd: string) => string | null;
  /** The permitted root, used to relativise a resolved path. */
  readonly root: string;
  /**
   * US-002: true when the command runs inside the OS sandbox (an available
   * launcher). A token that only NAMES a feature PRD is then no longer refused
   * -- reading it through Bash costs nothing, and the sandbox still blocks a
   * write. Absent or false screens exactly as before.
   */
  readonly sandboxWrapped?: boolean;
  /** S3-2: host-owned path rules; decides which tokens and redirects are refused and how. */
  readonly ownedPaths: OwnedPathsPolicy;
}

/**
 * US-002: the start paths that mean "search the whole filesystem". An exact
 * token comparison, never a prefix one: `~/proj` and `~user` are scoped and
 * allowed, while `~` and `~/` are not.
 */
const BRACE_HOME = "$" + "{HOME}";

const WHOLE_FILESYSTEM_STARTS: ReadonlySet<string> = new Set([
  "/",
  "~",
  "~/",
  "$HOME",
  "$HOME/",
  BRACE_HOME,
  `${BRACE_HOME}/`,
]);

/**
 * US-002: the whole-filesystem start path of a `find` segment, or undefined.
 *
 * The start paths are the tokens after `find` -- and after any leading `-H`,
 * `-L` or `-P` -- up to the first token that begins with `-`, `(` or `!`. The
 * comparison uses the token TEXT (opaque tokens included: `$HOME` lexes as
 * opaque and must still match).
 */
function wholeFilesystemFind(tokens: readonly BashToken[]): string | undefined {
  if (tokens[0]?.text !== "find") return undefined;
  let index = 1;
  while (index < tokens.length) {
    const text = tokens[index]?.text;
    if (text !== "-H" && text !== "-L" && text !== "-P") break;
    index += 1;
  }
  for (; index < tokens.length; index += 1) {
    const text = tokens[index]?.text ?? "";
    if (text.startsWith("-") || text.startsWith("(") || text.startsWith("!")) break;
    if (WHOLE_FILESYSTEM_STARTS.has(text)) return text;
  }
  return undefined;
}

function deny(reason: string): BashCheck {
  // Never escalatable: a protected-path write is affirmatively out of bounds,
  // not a command the gate merely could not read.
  return { kind: "deny", reason, breach: false, escalatable: false };
}

/**
 * One `OwnedBashCandidate` per live frame, in frame order.
 *
 * The two passes are the policy's now (`OwnedPathsPolicy.bashRefusal`); this
 * function only supplies the evidence, one candidate per frame.
 *
 * Built against EVERY frame in `cwd`, mirroring the conservatism of gated
 * mode's own `resolveAll`: a `;`-joined `cd` can leave more than one frame
 * live at once (see `nextWorkingDirectories`), and a candidate that is safe
 * from one frame but hits an owned path from another must still be seen.
 *
 * Per frame, the candidate carries both halves of today's two-pass order:
 *
 * 1. `lexical`: the candidate resolved lexically against the frame --
 *    `realOrRaw` walks to the nearest existing ancestor, so a not-yet-created
 *    file under a symlinked temp root still compares equal to
 *    `realOrRaw(root)`. The policy's lexical config check runs
 *    on this, BEFORE the resolver is consulted -- the raw screen has no typed
 *    seam in front of it, and `resolvePath` (production: `resolveWithin`)
 *    returns null for `.nax/config.json` exactly because typed tools are
 *    SUPPOSED to refuse those writes.
 *
 * 2. `rel`: the typed-seam resolver's root-relative spelling for the same
 *    frame, null when it refused or the path is outside the root. The
 *    policy's PRD/queue check runs on this.
 */
function ownedCandidates(args: RawScreenArgs, candidate: string, cwd: readonly string[]): OwnedBashCandidate[] {
  return cwd.map((directory) => {
    const resolved = args.resolvePath(candidate, directory);
    const rel = resolved === null ? null : relative(args.root, resolved).split(sep).join("/");
    return {
      lexical: realOrRaw(resolve(directory, candidate)),
      rel: rel === null || rel.startsWith("..") ? null : rel,
    };
  });
}

export function screenRawBashCommand(args: RawScreenArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  // The inversion: unreadable means unscreened, and unscreened means allowed.
  if (lexed.kind === "refused") return { kind: "allow" };

  let cwd: readonly string[] = [args.initialPath];
  const sandboxWrapped = args.sandboxWrapped === true;
  for (const segment of lexed.segments) {
    // US-002 COST GUARD (see the file header): a `find` rooted at the whole
    // filesystem walks every mount and runs into the 300s Bash timeout. Raw has
    // no containment, so nothing else stops it. Not a boundary -- a cost guard.
    const findStart = wholeFilesystemFind(segment.tokens);
    if (findStart !== undefined) {
      return deny(
        `\`find ${findStart}\` searches the whole filesystem and runs into the 300s Bash timeout. ` +
          `Search within the repository root instead: ${args.root}`,
      );
    }
    // US-002: sandbox-wrapped, a token that only NAMES a PRD is allowed -- the
    // policy now applies that exemption (`bashRefusal` receives
    // `sandboxWrapped` and skips the PRD read itself). A redirect WRITES, so
    // the policy refuses it even sandbox-wrapped, with the read/write truth.
    for (const token of segment.tokens) {
      if (token.opaque) continue;
      const reason = args.ownedPaths.bashRefusal(tool, token.text, ownedCandidates(args, token.text, cwd), {
        root: args.root,
        verb: "names",
        sandboxWrapped,
      });
      if (reason !== undefined) return deny(reason);
    }
    for (const redirect of segment.redirects) {
      if (redirect.opaque) continue;
      const reason = args.ownedPaths.bashRefusal(tool, redirect.target, ownedCandidates(args, redirect.target, cwd), {
        root: args.root,
        verb: "redirects into",
        sandboxWrapped,
      });
      if (reason !== undefined) return deny(reason);
    }

    // See the file header ("THE CRITICAL ASYMMETRY"). An unmodelled `cd` is
    // never itself a denial -- that inversion from gated mode is deliberate --
    // but it does not end the screen either: the frame set simply stays where
    // it was and the later segments are still checked against it. Returning
    // `allow` here instead would let `cd - ; echo ABORT > .queue.txt` through.
    const cdResult = cdTargetsFor(segment, cwd, args.resolvePath);
    if (cdResult.kind === "resolved") {
      cwd = nextWorkingDirectories(segment, cwd, cdResult.targets);
    }
  }

  return { kind: "allow" };
}
