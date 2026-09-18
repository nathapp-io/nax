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

/**
 * The path-bearing tools that MUTATE. Read, Grep, Glob and Git are read-only
 * and are deliberately absent: an agent legitimately reads its own PRD, and
 * refusing that would break ordinary work to close one hole.
 *
 * Bash and Exec are absent because they carry no path fields -- a shell
 * redirect into `.nax/` is gated by the human-authored `Bash(...)` rules and
 * the lexer, which is a different seam from this one.
 */
export const NAX_OWNED_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete", "GitCommit"]);

/**
 * nax's run-control files at the root: the command channel an agent could
 * otherwise use to PAUSE, ABORT or SKIP stories without writing any code.
 *
 * `.queue.txt.processing` is the atomic-rename target the queue handler reads
 * from (src/execution/queue-handler.ts), so guarding only `.queue.txt` would
 * leave the same hole one rename downstream.
 */
const QUEUE_CONTROL_FILES: ReadonlySet<string> = new Set([".queue.txt", ".queue.txt.processing"]);

/**
 * Why `tool` may not touch `rel`, or `undefined` when it may.
 *
 * `rel` MUST be the canonical, posix-separated, root-relative spelling the
 * policy itself derived -- never the caller's own. Matching the caller's
 * spelling means this guard and the policy that approved the call are reading
 * different strings, and every alternate spelling ("./x", "a/../x") walks past
 * the guard. Same rule, and the same reason, as `matchesDenyPaths`.
 *
 * The PRD defines the acceptance criteria the story is judged against. An
 * agent that can rewrite it can pass any review without writing any code,
 * which defeats the review layer without touching a config file.
 *
 * The queue file is the other half of the same concern: it is the run-control
 * channel, and a write there can pause, abort or skip stories outright.
 */
export function naxOwnedWriteRefusal(tool: string, rel: string, exemptRel?: string): string | undefined {
  if (!NAX_OWNED_WRITE_TOOLS.has(tool)) return undefined;
  const segments = rel.split("/");
  // SEC-5: the run-control file lives at the root, so match it exactly
  // there and not at any other depth -- a nested `sub/.queue.txt` is an
  // ordinary file, not the queue nax reads.
  if (segments.length === 1 && QUEUE_CONTROL_FILES.has(segments[0] ?? "")) {
    return `"${rel}" is nax's own run state: it carries the PAUSE/ABORT/SKIP commands that control this run, so no tool may modify it. Change the run through the queue command, not by writing its file.`;
  }
  const isFeaturePrd =
    segments[0] === ".nax" && segments[1] === "features" && segments[segments.length - 1] === "prd.json";
  if (!isFeaturePrd) return undefined;
  // nax#2115: the plan session is the ONE writer of a PRD -- its op declares
  // `fileOutput: (input) => input.outputPath` and every plan prompt instructs
  // the agent to write the PRD there rather than reply with it. #2095 added
  // this guard without an exemption, which severed that contract and left
  // `nax plan` unable to produce a PRD in ANY mode.
  //
  // The exemption is PATH-EXACT, not role-shaped: the plan session may write
  // the single path its own op declared, and nothing else. A sibling feature's
  // PRD stays refused even to the plan session, so a planner cannot reach
  // across features to rewrite criteria it is not authoring. `exemptRel` must
  // be the caller's canonical, posix-separated, root-relative spelling --
  // derived by the policy itself, never taken from the agent's own arguments.
  if (exemptRel !== undefined && rel === exemptRel) return undefined;
  return `"${rel}" is nax's own run state: it holds the acceptance criteria this story is judged against, so no tool may modify it. Change the code, not the criteria.`;
}
