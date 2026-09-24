/**
 * The `raw` bash mode screen (ADR-030).
 *
 * `raw` is pass-through: no per-segment grant matching, no root containment,
 * and — unlike `checkBashCommand` — a command the lexer CANNOT read is ALLOWED
 * rather than refused. That inversion is the whole point of the mode.
 *
 * The one thing this screen still does is catch a naive mistake: if the lexer
 * CAN parse the command and a segment names or redirects into a path nax owns
 * (`.nax/config.json`, `.nax/mono/*\/config.json`, `.nax/features/**\/prd.json`,
 * the root queue-control files), the command is denied.
 *
 * ADVISORY BY CONSTRUCTION. A command using substitution is not parsed and
 * therefore is not screened at all: `sh -c "$(echo rm) .nax/features/f/prd.json"`
 * passes straight through. This is a mistake-catcher, not a boundary, and it
 * must never grow into a general gate — gating lives in policy, once
 * (`src/tools/bash.ts:14-19`).
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
import { lexBashCommand } from "@/permissions";
import { realOrRaw } from "@/utils/realpath";
import { cdTargetsFor, nextWorkingDirectories } from "./bash-cwd";
import { isNaxConfigFile, isNaxOwnedWritePath } from "./nax-owned-writes";
import type { BashCheck } from "./policy-bash";

export interface RawScreenArgs {
  readonly tool: string;
  readonly command: unknown;
  /** The shell's initial working directory. */
  readonly initialPath: string;
  /** Resolves a candidate from an effective shell working directory. */
  readonly resolvePath: (candidate: string, cwd: string) => string | null;
  /** The permitted root, used to relativise a resolved path. */
  readonly root: string;
}

function deny(reason: string): BashCheck {
  // Never escalatable: a protected-path write is affirmatively out of bounds,
  // not a command the gate merely could not read.
  return { kind: "deny", reason, breach: false, escalatable: false };
}

/**
 * A protected path, named for the refusal message, or undefined.
 *
 * Checked against EVERY frame in `cwd`, mirroring the conservatism of gated
 * mode's own `resolveAll`: a `;`-joined `cd` can leave more than one frame
 * live at once (see `nextWorkingDirectories`), and a candidate that is safe
 * from one frame but hits a protected path from another must still deny.
 *
 * Two passes, in order:
 *
 * 1. LEXICAL nax-config check. The raw screen has no typed seam in front of
 *    it, and `args.resolvePath` (production: `resolveWithin`) returns null
 *    for `.nax/config.json` exactly because typed tools are SUPPOSED to refuse
 *    those writes. Falling through to that null would let the entire class
 *    of nax-config writes go unscreened. Resolve the candidate lexically
 *    against each frame -- `realOrRaw` walks to the nearest existing ancestor,
 *    so a not-yet-created file under a symlinked temp root still compares
 *    equal to `realOrRaw(root)` -- and refuse on `isNaxConfigFile` BEFORE the
 *    resolver is consulted.
 *
 * 2. Typed-seam resolver pass (unchanged). `args.resolvePath` continues to be
 *    the gate for everything else: a `null` skips this frame, an out-of-root
 *    path skips this frame, and `isNaxOwnedWritePath` covers the queue file
 *    and feature PRD set.
 *
 * The two checks do not overlap: pass 1 covers nax config files; pass 2 covers
 * feature PRDs and the queue run-control files. `isNaxConfigFile` is checked
 * lexically here because the resolver cannot return it, and lexically in
 * `resolveWithin` for the same reason; `isNaxOwnedWritePath` is unchanged.
 */
function protectedHit(args: RawScreenArgs, candidate: string, cwd: readonly string[]): string | undefined {
  for (const directory of cwd) {
    // Pass 1: lexical nax-config check. Independent of the resolver on
    // purpose -- see the comment above. `realOrRaw` walks to the nearest
    // existing ancestor so the comparison holds even when the file does not
    // yet exist on disk (which is the common case: the screen catches the
    // write BEFORE the file lands).
    const lexical = realOrRaw(resolve(directory, candidate));
    if (isNaxConfigFile(args.root, lexical)) return candidate;

    // Pass 2: typed-seam resolver (unchanged).
    const resolved = args.resolvePath(candidate, directory);
    if (resolved === null) continue;
    const rel = relative(args.root, resolved).split(sep).join("/");
    if (rel.startsWith("..")) continue;
    if (isNaxOwnedWritePath(rel)) return candidate;
  }
  return undefined;
}

export function screenRawBashCommand(args: RawScreenArgs): BashCheck {
  const { command, tool } = args;
  if (typeof command !== "string") return deny(`"command" must be a string`);
  if (command.trim() === "") return deny(`"command" must not be empty`);

  const lexed = lexBashCommand(command);
  // The inversion: unreadable means unscreened, and unscreened means allowed.
  if (lexed.kind === "refused") return { kind: "allow" };

  let cwd: readonly string[] = [args.initialPath];
  for (const segment of lexed.segments) {
    for (const token of segment.tokens) {
      if (token.opaque) continue;
      const hit = protectedHit(args, token.text, cwd);
      if (hit !== undefined) {
        return deny(
          `${tool} command names "${hit}", which nax owns and no tool may modify -- ` +
            "change it through nax rather than by writing its file",
        );
      }
    }
    for (const redirect of segment.redirects) {
      if (redirect.opaque) continue;
      const hit = protectedHit(args, redirect.target, cwd);
      if (hit !== undefined) {
        return deny(
          `${tool} command redirects into "${hit}", which nax owns and no tool may modify -- ` +
            "change it through nax rather than by writing its file",
        );
      }
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
