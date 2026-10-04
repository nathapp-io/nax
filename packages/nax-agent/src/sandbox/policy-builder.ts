/**
 * Pure: everything the sandbox allows and denies for one command (spec 5.3).
 *
 * Rebuilt per call so a `.nax/` entry created mid-run gets its deny (nax#2260).
 * Every emitted path goes through realOrRaw -- srt realpaths only paths
 * that exist, so a deny for a not-yet-created file under a symlinked temp dir
 * would otherwise keep a spelling the kernel never sees (spec 12, finding 3).
 */
import { isAbsolute, join, resolve } from "node:path";
import { NaxError } from "#src/infra/index";
import { realOrRaw } from "#src/internal/realpath";
import { SANDBOX_GLOB_CHARS, type SandboxConfig } from "../config/schemas-sandbox.ts";
import type { OwnedPathsPolicy } from "../tools/owned-paths.ts";
import {
  BUILTIN_CACHE_WRITE_ROOTS,
  BUILTIN_CREDENTIAL_READ_DENIES,
  MACOS_CACHE_WRITE_ROOT,
  SRT_MACOS_TMPDIR,
  SRT_MACOS_TMPDIR_DENIES,
} from "./defaults.ts";
import { WORKTREE_COMMON_WRITE_DIRS, WORKTREE_CONFIG_FILE } from "./git-guards.ts";
import type { GitLayout } from "./policy-inputs.ts";
import type { SandboxPolicy } from "./types.ts";

export interface SandboxPolicyInput {
  readonly root: string;
  readonly git: GitLayout;
  /** Redirecting git files present now, every worktree included (listGitGuardFiles, #2198). */
  readonly gitGuardFiles: readonly string[];
  /** Top-level entry names under `<root>/.nax` right now (listNaxEntries). */
  readonly naxEntries: readonly string[];
  /** S3-2: host-owned path rules; supplies the always-denied project-state entries and root files. */
  readonly ownedPaths: OwnedPathsPolicy;
  /** Project-relative state directory (ProtectedPathsPolicy.projectStateDir); absent: no project-state denies. */
  readonly projectStateDir?: string;
  readonly credentialFiles: readonly string[];
  readonly approvalsFile?: string;
  /** US-006 — the trust store (`trustStorePath()`), denied so a command cannot rewrite its own trust. */
  readonly trustStoreFile?: string;
  readonly home: string;
  readonly tempRoots: readonly string[];
  /**
   * #2301: whether THIS command's temp writes stay confined — the RESOLVE-time
   * answer ANDed with the fact that this launch's `TMPDIR` override is in force.
   *
   * It governs srt's forced TMPDIR on BOTH sides, not only the deny. On darwin,
   * `true` drops `/tmp/claude` from `writeRoots` and adds both of its spellings
   * to `denyWrite`; `false` does the reverse, so a command that did not confine
   * keeps `/tmp/claude` writable as a plain grant. `input.tempRoots` is passed
   * through either way: the flag moves srt's `/tmp/claude` grant, never the
   * session's own temp roots.
   *
   * Deliberately NOT the value behind `SandboxState.sharedTmp === false` or
   * `isTempConfined`. Those are the resolve-time answer, fixed when the launcher
   * is built, while this is re-decided on every launch by ANDing that answer with
   * whether the session temp dir was re-created. The two are MEANT to disagree: a
   * session whose dir fails to re-create keeps `sharedTmp: false` and
   * `isTempConfined() === true` while this reads `false` for that one command. Do
   * not reconcile them by making either one follow the other.
   *
   * Absent means it confined neither way, so every construction outside
   * `resolveSessionSandbox` keeps today's behaviour; the only other builder in
   * the tree, the probe, writes its policy as a literal and never reaches here.
   */
  readonly confined?: boolean;
  readonly platform: NodeJS.Platform;
  readonly config: SandboxConfig;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** Throws on a glob: a Linux backend would drop it silently (F1), so fail closed instead. */
function literal(paths: readonly string[]): string[] {
  const resolved = [...new Set(paths.map((p) => realOrRaw(p)))];
  const glob = resolved.find((p) => SANDBOX_GLOB_CHARS.test(p));
  if (glob !== undefined) {
    throw new NaxError(`[sandbox] policy path is not literal (glob character): ${glob}`, "SANDBOX_POLICY_NOT_LITERAL", {
      stage: "sandbox",
      path: glob,
    });
  }
  return resolved;
}

function gitDenies(root: string, git: GitLayout): string[] {
  if (git.kind === "none") return [];
  const common = git.kind === "worktree" ? git.commonDir : git.gitDir;
  // config.worktree is read when extensions.worktreeConfig is on; an absent one
  // is safe to deny (srt stubs it empty, and empty is valid config) (#2198).
  const shared = [join(common, "hooks"), join(common, "config"), join(common, WORKTREE_CONFIG_FILE)];
  if (git.kind === "main") return shared;
  // A worktree's `.git` is a pointer FILE, and gitdir/commondir point back;
  // repointing any of them at an agent-written config (core.hooksPath) would
  // make nax's own unsandboxed git run hooks (spec 12, finding 4).
  return [
    ...shared,
    join(root, ".git"),
    join(git.gitDir, "gitdir"),
    join(git.gitDir, "commondir"),
    join(git.gitDir, WORKTREE_CONFIG_FILE),
  ];
}

/**
 * A worktree's own admin dir plus the shared subdirs its git writes -- never
 * the whole common dir, whose top-level `commondir` would otherwise be a live
 * redirect for concurrent unsandboxed git while the command runs (#2211).
 * srt skips a write root that does not exist yet.
 */
function worktreeGitWriteRoots(git: GitLayout): string[] {
  if (git.kind !== "worktree") return [];
  return [git.gitDir, ...WORKTREE_COMMON_WRITE_DIRS.map((dir) => join(git.commonDir, dir))];
}

/**
 * nax#2260: every top-level project-state entry, whole, plus the ones the host
 * loads even when absent (`ownedPaths.deniedEntries`) -- except the scratchpad
 * and entries opted in via allowWrite. The ENTRIES come from the owned-paths
 * port; the DIRECTORY comes from `projectStateDir`, and its absence denies
 * nothing. srt applies deny over allow and on Linux turns every literal deny
 * into a bind mount, so whole entries (one `features` deny, not one per PRD)
 * keep both the protection and the per-command cost bounded.
 *
 * Only `<root>/<projectStateDir>` is covered. A monorepo package's own `.nax/`
 * (`packages/<pkg>/.nax/`) is deliberately excluded: what lives there --
 * cache/, scratchpad/, status.json, the features' acceptance tests and run
 * artifacts -- is gitignored and rebuilt or regenerated, so deleting it is
 * harmless, and the package's config sits under the root's protected `mono/`.
 * The exception is an optional `packages/<pkg>/.nax/rules/`, which nax loads
 * into prompts; covering it needs package discovery, because a `.nax/` at any
 * depth also matches test-fixture projects (`test/fixtures/<p>/.nax/`).
 */
function projectStateDenies(input: SandboxPolicyInput): string[] {
  const { root, projectStateDir, ownedPaths } = input;
  if (projectStateDir === undefined) return [];
  const optIns = ownedPaths.writeOptIns(root, input.config.filesystem.allowWrite);
  return [...new Set([...input.naxEntries, ...ownedPaths.deniedEntries])]
    .filter((name) => name !== ownedPaths.scratchpadEntry && !optIns.has(name))
    .map((name) => join(root, projectStateDir, name));
}

export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const { root, home, config } = input;
  const darwin = input.platform === "darwin";
  // #2301: a CONFINED session does not need srt's forced TMPDIR. srt always
  // allows `/tmp/claude` (`SANDBOX_OWN_WRITE_PATHS`) and hands the child a
  // `TMPDIR` of `/tmp/claude` (sandbox-utils.js:630), and in a macOS Seatbelt
  // profile it renders the allow rules before the deny rules, where the later deny
  // wins — so the only way to take the write back is an explicit deny, which is
  // what a confined session gets.
  //
  // Both spellings, because `realOrRaw` resolves the nearest EXISTING ancestor and
  // `/tmp` exists: on a stock macOS host `/tmp` is a symlink to `/private/tmp`, so
  // `literal()` collapses the pair to one entry and it costs nothing there. The
  // pair still matters on a host where `/tmp` is a real directory, or a symlink
  // somewhere other than `/private/tmp`: there the two resolve apart and a single
  // spelling would leave srt's other one writable.
  //
  // Nothing needs the grant instead: a session is confined only when it HAS a temp
  // dir, and `runWrapped` prefixes the command with
  // `export TMPDIR=<that dir> TMP=… TEMP=…` (src/sandbox/launcher.ts:138),
  // replacing srt's value before the agent's command runs. That prefix rides on
  // `createCommandLauncher`'s per-run mkdir (src/sandbox/launcher.ts:194), so it is
  // conditional — when the mkdir fails the override is dropped and the agent's
  // `TMPDIR` is srt's `/tmp/claude` again, which is why that case needs deciding
  // before a deny can be relied on.
  //
  // A session that did NOT confine keeps the grant: its temp roots are
  // `defaultTempRoots`, which allows `/tmp` outright, so `/tmp/claude` is inside an
  // allowed root anyway and a deny would contradict the session's own denial hint
  // (`denialHintLine`).
  //
  // darwin only, deliberately: srt's `SANDBOX_OWN_WRITE_PATHS` is
  // platform-independent, so a confined LINUX session still gets `/tmp/claude`.
  // Left open on purpose — on bwrap a literal deny becomes a bind mount, a
  // different mechanism that needs its own check before a deny is added there.
  const confined = input.confined === true;
  const writeRoots = literal([
    root,
    ...worktreeGitWriteRoots(input.git),
    ...input.tempRoots,
    ...(darwin ? [...(confined ? [] : [SRT_MACOS_TMPDIR]), join(home, MACOS_CACHE_WRITE_ROOT)] : []),
    ...BUILTIN_CACHE_WRITE_ROOTS.map((rel) => join(home, rel)),
    ...config.filesystem.allowWrite.map((p) => {
      const expanded = expandHome(p, home);
      return isAbsolute(expanded) ? expanded : resolve(root, expanded);
    }),
  ]);
  const denyWrite = literal([
    ...projectStateDenies(input),
    ...input.ownedPaths.rootWriteDenies.map((name) => join(root, name)),
    ...gitDenies(root, input.git),
    ...input.gitGuardFiles,
    ...(input.approvalsFile !== undefined ? [input.approvalsFile] : []),
    ...(input.trustStoreFile !== undefined ? [input.trustStoreFile] : []),
    ...(darwin && confined ? SRT_MACOS_TMPDIR_DENIES : []),
  ]);
  const denyRead = literal([
    ...BUILTIN_CREDENTIAL_READ_DENIES.map((rel) => join(home, rel)),
    ...input.credentialFiles,
    ...config.filesystem.denyRead.map((p) => resolve(root, expandHome(p, home))),
  ]);
  const allowed = config.network.allowedDomains;
  return { writeRoots, denyWrite, denyRead, network: allowed === undefined ? {} : { allowedDomains: [...allowed] } };
}
