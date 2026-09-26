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

import { isAbsolute, relative, resolve, sep } from "node:path";
import { realOrRaw } from "@/utils/realpath";

/**
 * The one top-level `.nax/` entry agents may write freely: the scratchpad.
 * Must equal the last segment of SCRATCHPAD_DIR (pinned by a test; importing
 * it here would close a scratchpad -> policy -> nax-owned-writes cycle).
 */
export const NAX_SCRATCHPAD_ENTRY = "scratchpad";

/**
 * Top-level `.nax/` entries an allowWrite opt-in can never open (nax#2260):
 * config is the trust anchor for ungated commands, `mono` holds package
 * configs, and `features` holds every PRD plus the running feature's state.
 */
const NAX_NEVER_OPT_IN: ReadonlySet<string> = new Set(["config.json", "mono", "features"]);

/**
 * Entries nax reads as human-authored input. The sandbox denies these even
 * when absent, so an agent cannot create one (a new `.nax/rules/x.md` would be
 * injected into every later session's prompt). nax never creates them mid-run.
 */
export const NAX_ALWAYS_DENIED_ENTRIES: readonly string[] = ["config.json", "mono", "rules", "context.md"];

const NO_OPT_INS: ReadonlySet<string> = new Set();

/**
 * Top-level `.nax/` entries a human opened for agent writes by listing them in
 * `execution.sandbox.filesystem.allowWrite` (nax#2260). Only an exact entry
 * counts -- `.nax/rules`, never `.nax/rules/a.md` -- and never the scratchpad
 * (always open) or a NAX_NEVER_OPT_IN entry. Relative entries resolve against
 * `root`, as the sandbox's own write roots do.
 */
export function naxWriteOptIns(root: string, allowWrite: readonly string[]): ReadonlySet<string> {
  const naxDir = resolve(root, ".nax");
  const names = allowWrite
    .map((p) => relative(naxDir, isAbsolute(p) ? resolve(p) : resolve(root, p)))
    .filter((rel) => rel !== "" && !rel.startsWith("..") && !rel.includes(sep) && !isAbsolute(rel))
    .filter((name) => name !== NAX_SCRATCHPAD_ENTRY && !NAX_NEVER_OPT_IN.has(name));
  return new Set(names);
}

/** `.nax/config.json`, or `.nax/mono/<package...>/config.json`, as root-relative segments. */
function isNaxConfigSegments(segments: readonly string[]): boolean {
  if (segments[0] !== ".nax" || segments[segments.length - 1] !== "config.json") return false;
  return segments.length === 2 || (segments.length >= 4 && segments[1] === "mono");
}

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
  // `.nax/config.json` (2), or `.nax/mono/<package>/config.json` at ANY package
  // depth (>= 4). The real override path is nested -- `loadConfigForWorkdir`
  // reads `.nax/mono/<packageDir>/config.json` where packageDir is the
  // repo-relative package path (`src/config/loader.ts:382`), so a normal
  // `packages/*` layout is 5 segments, not 4. A length-exact rule left every
  // such override writable whenever the story's root was the repo root.
  return isNaxConfigSegments(rel.split(sep));
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
export const QUEUE_CONTROL_FILES: ReadonlySet<string> = new Set([".queue.txt", ".queue.txt.processing"]);

/**
 * The kinds of nax-owned path the raw Bash screen refuses by name.
 * `"config"` is produced by the lexical `isNaxConfigFile` pass, never by
 * `naxOwnedKind` -- see that function.
 */
export type NaxOwnedKind = "prd" | "queue" | "config";

/**
 * Is this path one nax owns the writes to, independent of WHICH tool is asking?
 *
 * `naxOwnedWriteRefusal` answers the same question for the four file-writing
 * tools and returns prose. This predicate is the tool-agnostic half, extracted
 * so the `raw` bash screen (ADR-030) can consult exactly the same path set
 * without being in `NAX_OWNED_WRITE_TOOLS`. One definition, two callers.
 *
 * @param rel - Path relative to the permitted root, `/`-joined.
 */
export function isNaxOwnedWritePath(rel: string): boolean {
  return naxOwnedKind(rel) !== undefined;
}

/**
 * Which kind of nax-owned write path `rel` is, or undefined when it is not one.
 *
 * `/`-joined and root-relative, like `isNaxOwnedWritePath`. Never returns
 * `"config"` -- nax config files are recognised by the lexical
 * `isNaxConfigFile` pass, which callers (`protectedHit` in policy-bash-raw.ts)
 * run FIRST. Keeping the two apart is what lets the raw screen name the kind it
 * matched without duplicating the config rule here.
 */
export function naxOwnedKind(rel: string): "prd" | "queue" | undefined {
  const segments = rel.split("/");
  // SEC-5: the run-control file lives at the root, so match it exactly there
  // and not at any other depth -- a nested `sub/.queue.txt` is an ordinary
  // file, not the queue nax reads.
  if (segments.length === 1 && QUEUE_CONTROL_FILES.has(segments[0] ?? "")) return "queue";
  if (segments[0] === ".nax" && segments[1] === "features" && segments[segments.length - 1] === "prd.json") {
    return "prd";
  }
  return undefined;
}

/**
 * Refusal text for a Bash command that names (verb "names") or redirects into
 * (verb "redirects into") a nax-owned file.
 *
 * Kind-specific on purpose. The previous screen returned one modification-only
 * sentence for every kind, which read as "you cannot WRITE this" -- so an agent
 * that only wanted to READ a PRD retried a command it will never be allowed to
 * run. Each branch now says what the file IS and what the agent can do instead.
 *
 * The text never spells `.nax/features/` literally: `src/tools/` is covered by
 * the `check:feature-dir-ssot` gate, so the PRD branch names the token the agent
 * used (`hit`) rather than the tree layout.
 */
export function naxOwnedBashRefusal(
  tool: string,
  kind: NaxOwnedKind,
  hit: string,
  verb: "names" | "redirects into",
): string {
  switch (kind) {
    case "prd":
      return (
        `${tool} command ${verb} "${hit}", which holds this story's acceptance criteria. ` +
        "nax updates it itself during the run, so it shows as modified. " +
        "Bash commands naming it are refused, reads included -- leave it as is. " +
        "To view it, use the `Read` tool."
      );
    case "queue":
      return (
        `${tool} command ${verb} "${hit}", which is nax's run-control queue. ` +
        "Bash commands naming it are refused, reads included -- change the run through the queue command."
      );
    case "config":
      return (
        `${tool} command ${verb} "${hit}", which is nax configuration. ` +
        "Bash commands naming it are refused, reads included -- nax configuration is not changed from inside a run."
      );
  }
}

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
export function naxOwnedWriteRefusal(
  tool: string,
  rel: string,
  exemptRel?: string,
  optIns: ReadonlySet<string> = NO_OPT_INS,
): string | undefined {
  if (!NAX_OWNED_WRITE_TOOLS.has(tool)) return undefined;
  if (!isNaxOwnedWritePath(rel)) {
    return exemptRel !== undefined && rel === exemptRel ? undefined : naxStateRefusal(rel, optIns);
  }
  const segments = rel.split("/");
  // SEC-5: the run-control file lives at the root, so match it exactly
  // there and not at any other depth -- a nested `sub/.queue.txt` is an
  // ordinary file, not the queue nax reads.
  if (segments.length === 1) {
    return `"${rel}" is nax's own run state: it carries the PAUSE/ABORT/SKIP commands that control this run, so no tool may modify it. Change the run through the queue command, not by writing its file.`;
  }
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

/**
 * nax#2260: everything else under `.nax/` is nax's own state. Writable: the
 * scratchpad, files directly inside a feature dir (acceptance and suggested
 * tests, under whatever name acceptance.testPath gives them -- the tool-audit
 * ledgers show these are the only file-tool writes agents need there), and
 * opted-in entries. Config files are left to the earlier, more specific
 * `isNaxConfigFile` refusal, which covers reads too.
 */
function naxStateRefusal(rel: string, optIns: ReadonlySet<string>): string | undefined {
  const segments = rel.split("/");
  if (segments[0] !== ".nax" || isNaxConfigSegments(segments)) return undefined;
  const entry = segments[1];
  if (segments.length > 2 && (entry === NAX_SCRATCHPAD_ENTRY || optIns.has(entry ?? ""))) return undefined;
  if (segments.length === 4 && entry === "features") return undefined;
  return (
    `"${rel}" is nax's own state, which agents do not modify. Under .nax/, write only to your scratchpad ` +
    "(.nax/scratchpad/) or to a file directly inside a feature directory, such as its acceptance test. " +
    "A human can open a path for a story by listing it in execution.sandbox.filesystem.allowWrite in the project config."
  );
}
