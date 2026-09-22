/**
 * Per-segment shell working-directory tracking, shared by the two Bash
 * payload screens (`policy-bash.ts`'s `checkBashCommand` and
 * `policy-bash-raw.ts`'s `screenRawBashCommand`).
 *
 * A `cd` in one segment moves the frame of reference for every LATER segment
 * in the same command (`cd child && cat ../secret` reads `<root>/secret`, not
 * `<root>/child/secret`), so both screens must track it identically to avoid
 * being fooled by it. This module is the ONE definition of "what does a `cd`
 * segment resolve to, and how do separators fold that into the running set
 * of candidate working directories" -- mirroring `isNaxOwnedWritePath` in
 * `nax-owned-writes.ts`, which is the same one-definition-two-callers shape
 * for a different seam.
 *
 * What this module does NOT decide: what happens when a `cd` cannot be
 * modelled (an option-shaped target, an opaque one, one that fails to
 * resolve). The two callers have OPPOSITE answers to that question --
 * `checkBashCommand` denies (containment is the whole point of gated mode),
 * `screenRawBashCommand` must fail open (raw enforces no containment by
 * definition; see the caller's own docblock for why). `cdTargetsFor` reports
 * WHY a `cd` could not be modelled and leaves the verdict to the caller.
 */
import type { BashSegment } from "@/permissions";

/**
 * The outcome of inspecting one segment for a `cd`:
 *
 * - `not-cd`: the segment does not start with `cd`; nothing to track.
 * - `resolved`: a `cd` whose target resolved against EVERY current frame.
 * - `no-target`: `cd` with no argument at all.
 * - `option-shaped`: the target starts with `-` (`cd -`, `cd -P dir`) and
 *   puts the path in a slot this reader does not parse.
 * - `opaque`: the target contains `$`-expansion; its runtime value is
 *   unknown here.
 * - `unresolved`: the target failed to resolve from at least one current
 *   frame (root escape, `.git/`, or whatever `resolvePath` itself refuses).
 */
export type CdTargetResult =
  | { readonly kind: "not-cd" }
  | { readonly kind: "resolved"; readonly targets: readonly string[] }
  | { readonly kind: "no-target" }
  | { readonly kind: "option-shaped"; readonly text: string }
  | { readonly kind: "opaque"; readonly text: string }
  | { readonly kind: "unresolved"; readonly text: string };

/**
 * Reads a segment as a possible `cd`, resolving its target against every
 * frame in `cwd` via the caller-supplied `resolvePath` (the same containment
 * callback both policy modules already receive from `policy.ts`).
 *
 * Resolves against ALL frames, not just the first, for the same reason
 * `checkPayload`'s old `resolveAll` did: after a `;`-joined `cd`, more than
 * one frame can be live at once (see `nextWorkingDirectories` below), and a
 * target that is safe from one frame but escapes from another must not be
 * silently narrowed to the safe one.
 */
export function cdTargetsFor(
  segment: BashSegment,
  cwd: readonly string[],
  resolvePath: (candidate: string, cwd: string) => string | null,
): CdTargetResult {
  const words = segment.tokens.map((token) => token.text);
  if (words[0] !== "cd") return { kind: "not-cd" };

  const target = segment.tokens[1];
  if (target === undefined) return { kind: "no-target" };

  // `cd -` returns to $OLDPWD and `cd -P x` puts the path in a later slot:
  // both leave a naive reader tracking `<root>/-` as the new frame of
  // reference while the shell is somewhere else. Option-shaped, not modelled.
  if (target.text.startsWith("-")) return { kind: "option-shaped", text: target.text };
  if (target.opaque) return { kind: "opaque", text: target.text };

  const resolved = cwd.map((directory) => resolvePath(target.text, directory));
  if (!resolved.every((path): path is string => path !== null)) return { kind: "unresolved", text: target.text };
  return { kind: "resolved", targets: resolved };
}

/**
 * Folds a segment's `cd` targets (if any) into the running set of candidate
 * working directories, per the separator that FOLLOWS it:
 *
 * - `&&`: the shell only reaches the next segment if this one succeeded, and
 *   a successful `cd` REPLACES the working directory outright.
 * - `;`: the next segment runs regardless of whether the `cd` succeeded, so
 *   both the old and new frames stay live -- the command might still be
 *   sitting in the OLD directory when the next segment runs.
 * - anything else (`||`, `|`, `&`, or no separator / the last segment): a
 *   `cd`'s effect on a LATER segment is not modelled, so the frame set is
 *   left unchanged.
 *
 * `cdTargets` is `undefined` for a non-`cd` segment (or one this reader could
 * not resolve, per `cdTargetsFor`), in which case the frame set never changes.
 */
export function nextWorkingDirectories(
  segment: BashSegment,
  current: readonly string[],
  cdTargets: readonly string[] | undefined,
): readonly string[] {
  if (cdTargets === undefined) return current;
  if (segment.separator === "&&") return cdTargets;
  if (segment.separator === ";") return [...new Set([...current, ...cdTargets])];
  return current;
}
