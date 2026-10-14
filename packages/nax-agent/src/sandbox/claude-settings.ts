import { join, relative, sep } from "node:path";
import { realOrRaw } from "#src/internal/realpath";

/**
 * US-006: the two session-root Claude Code settings files.
 *
 * Claude Code loads `allow` rules, hooks and MCP servers from these files at
 * the session ROOT, so a write into one weakens every later session started in
 * that workdir — a privilege escalation that survives the run that made it.
 *
 * One canonical list, because two independent guards consume it and they must
 * never diverge:
 *
 *   - the OS sandbox denies writes to these paths (`buildSandboxPolicy`), which
 *     covers a sandboxed command (Bash, RunCommand) and the ACP edit path;
 *   - the native tool policy refuses the same writes (`claudeSettingsWriteRefusal`
 *     through `compileToolPolicy`), which is the ONLY guard on the native
 *     `Write` / `Edit` / `Delete` tools — they run through Node's fs APIs with no
 *     sandbox around them (branch review B1).
 *
 * `.claude` itself is deliberately NOT listed: a project keeps skills, commands
 * and agents under it, so this is a file deny, never a directory one (on Linux
 * srt turns a directory deny into a bind mount over all of them). The sandbox
 * resolves each entry through the same `literal()`/`realOrRaw` path as every
 * other entry, so the deny holds whether or not the file — or `.claude/` itself
 * — exists yet.
 *
 * Only the session root's own files are listed. A monorepo package's
 * `packages/<pkg>/.claude/settings.json` is out of scope (spec, "Out of Scope").
 */
export const CLAUDE_SETTINGS_FILES: readonly string[] = [".claude/settings.json", ".claude/settings.local.json"];

/**
 * The path-mutating tools this deny covers: the three that resolve a path
 * through `compileToolPolicy` and then write it with Node's fs APIs.
 *
 * `GitCommit` is deliberately absent — committing a settings file does not
 * change it, and the deny is about the file's CONTENT. Read-only tools are
 * absent for the other reason: a session must be able to read the settings it
 * is bound by, or a refusal becomes indistinguishable from a broken environment.
 */
const CLAUDE_SETTINGS_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete"]);

/**
 * Why `tool` may not modify the root-relative path `rel`, or undefined.
 *
 * `rel` must be the policy's OWN canonical spelling (root-relative, `/`-joined,
 * symlink-resolved), never the caller's arguments: matching the caller's
 * spelling would let `./.claude/settings.json` or `.claude/../.claude/x` walk
 * past this guard while reaching the same file.
 *
 * Because `rel` is symlink-resolved, each settings entry is resolved the same
 * way before it is compared (branch review B2): a `.claude/settings.json` that
 * is a symlink, or a `.claude/` that is one, arrives here as its target, and a
 * literal-only match would let the write through. Resolved per call, not at
 * policy compile time, so a symlink created mid-session is still seen.
 *
 * Segment-exact on the full path — a sibling such as `settings.json.bak`, or any
 * other file under `.claude/`, is an ordinary path a tool must still reach.
 */
export function claudeSettingsWriteRefusal(tool: string, rel: string, resolvedRoot: string): string | undefined {
  if (!CLAUDE_SETTINGS_WRITE_TOOLS.has(tool)) return undefined;
  const entry = CLAUDE_SETTINGS_FILES.find((e) => e === rel || resolvedSettingsRel(resolvedRoot, e) === rel);
  if (entry === undefined) return undefined;
  const subject =
    entry === rel
      ? `"${rel}" is a Claude Code settings file`
      : `"${rel}" is the target of the Claude Code settings file "${entry}"`;
  return (
    `${subject}: Claude loads allow rules, hooks and MCP servers from it for every ` +
    "session started in this workdir, so a change here outlives this run and is not made from inside it. " +
    "The sandbox refuses writes to it as well; a human changes it by hand, outside the run."
  );
}

/** `entry`'s symlink-resolved spelling, relative to the already-resolved root, `/`-joined. */
function resolvedSettingsRel(resolvedRoot: string, entry: string): string {
  return relative(resolvedRoot, realOrRaw(join(resolvedRoot, entry)))
    .split(sep)
    .join("/");
}
