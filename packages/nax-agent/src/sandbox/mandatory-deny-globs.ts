/**
 * #3038, macOS: the nested half of srt's mandatory write denies, beneath a root.
 *
 * srt's seatbelt profile denies, besides the cwd-level names, the same names at any
 * depth BENEATH THE PROCESS CWD (`macGetMandatoryDenyEntries`: `**\/<file>`,
 * `**\/<dir>/**`, `**\/.git/hooks/**`, `**\/.git/config`, each anchored at
 * `process.cwd()`). srt has no parameter to move that anchor, so a session root
 * that is not the cwd needs the same patterns named under the root.
 *
 * These are PATTERNS, which `buildSandboxPolicy` never emits (`literal()` refuses a
 * glob, because bwrap drops it). They are handed to srt per command by the srt
 * backend, on darwin only, where the profile compiles them to a regex.
 *
 * Two points of exactness with srt's own entries:
 *  - A directory name is matched by its CHILDREN (`<dir>/?*`, which compiles to the
 *    same regex as srt's `<dir>/**` entry). A literal `/**` suffix is stripped by srt
 *    from a caller's spelling, and the bare directory would then be denied as well,
 *    which srt's own nested entry does not do.
 *  - srt anchors its entries with an escaped literal prefix. A per-command string has
 *    no such form, and no escape for `*` or `?` exists in its glob dialect, so a root
 *    holding a glob character is refused instead of becoming a pattern. nax's policy
 *    builder already refuses such a root (`literal()`), so no session reaches this.
 */
import { NaxError } from "#src/infra/index";
import { SRT_MANDATORY_DENY_DIRS, SRT_MANDATORY_DENY_FILES } from "./defaults.ts";

/** Characters that srt's glob compiler reads as syntax (`]` closes a class), plus its own placeholder text. */
const PATTERN_SYNTAX = /[*?[\]]|__GLOBSTAR/;

export function rootMandatoryDenyGlobs(root: string): string[] {
  const hit = PATTERN_SYNTAX.exec(root);
  if (hit !== null) {
    throw new NaxError(
      `[sandbox] session root holds a glob character and cannot anchor a deny pattern: ${root}`,
      "SANDBOX_POLICY_NOT_LITERAL",
      { stage: "sandbox", path: root },
    );
  }
  return [
    ...SRT_MANDATORY_DENY_FILES.map((name) => `${root}/**/${name}`),
    ...SRT_MANDATORY_DENY_DIRS.map((name) => `${root}/**/${name}/?*`),
    `${root}/**/.git/hooks/?*`,
    `${root}/**/.git/config`,
  ];
}
