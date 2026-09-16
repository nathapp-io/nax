/**
 * Which paths nax refuses to let an agent touch, and to which tools.
 *
 * A separate file rather than an addition to src/tools/policy.ts, for the same
 * reason src/tools/deny-paths.ts is one: that file carries the containment
 * seam and sits at the project's file-size ratchet, while this is a narrower
 * concern -- it has nothing to do with resolving or containing a path, only
 * with refusing one containment would otherwise allow.
 *
 * Segment-exact, never a prefix or substring match: `.naxignore`,
 * `docs/nax/config.json` and `.nax/mono/api/notes.md` are ordinary paths a
 * tool must still reach.
 */

import { relative, sep } from "node:path";
import { realOrRaw } from "@/utils/realpath";

/**
 * Is `resolved` one of nax's own CONFIG files, relative to `root`?
 *
 * `.nax/config.json`, and `.nax/mono/<package>/config.json` in a monorepo.
 *
 * Why these at all: `quality.commands` and `acceptance.command` are run by key
 * through a shell and never pass the permission gate -- they are trusted
 * because a HUMAN wrote them. That trust rests entirely on a model being
 * unable to write them. An agent holding `Write` under the default
 * `unrestricted` profile could otherwise add a quality command and receive an
 * ungated shell on the next run, routing around every `Bash(...)` rule, the
 * lexer's construct refusals and containment itself.
 *
 * Refused to EVERY tool, reads included -- this is the pre-existing behaviour
 * and it is deliberate.
 */
export function isNaxConfigFile(root: string, resolved: string): boolean {
  const rel = relative(realOrRaw(root), resolved);
  if (rel === "" || rel.startsWith("..")) return false;
  const segments = rel.split(sep);
  if (segments[0] !== ".nax" || segments[segments.length - 1] !== "config.json") return false;
  // `.nax/config.json` (2), or `.nax/mono/<package>/config.json` at ANY package
  // depth (>= 4). The real override path is nested -- `loadConfigForWorkdir`
  // reads `.nax/mono/<packageDir>/config.json` where packageDir is the
  // repo-relative package path (`src/config/loader.ts:382`), so a normal
  // `packages/*` layout is 5 segments, not 4. A length-exact rule left every
  // such override writable whenever the story's root was the repo root.
  return segments.length === 2 || (segments.length >= 4 && segments[1] === "mono");
}
