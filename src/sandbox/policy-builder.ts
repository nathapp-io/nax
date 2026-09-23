/**
 * Pure: everything the sandbox allows and denies for one command (spec 5.3).
 *
 * Rebuilt per call so a feature directory created mid-run gets its prd.json
 * deny. Every emitted path goes through realOrRaw -- srt realpaths only paths
 * that exist, so a deny for a not-yet-created file under a symlinked temp dir
 * would otherwise keep a spelling the kernel never sees (spec 12, finding 3).
 */
import { isAbsolute, join, resolve } from "node:path";
import { SANDBOX_GLOB_CHARS, type SandboxConfig } from "../config/schemas-sandbox";
import { NaxError } from "../errors";
import { QUEUE_CONTROL_FILES } from "../tools/nax-owned-writes";
import { realOrRaw } from "../utils/realpath";
import {
  BUILTIN_CACHE_WRITE_ROOTS,
  BUILTIN_CREDENTIAL_READ_DENIES,
  MACOS_CACHE_WRITE_ROOT,
  SRT_MACOS_TMPDIR,
} from "./defaults";
import type { GitLayout } from "./policy-inputs";
import type { SandboxPolicy } from "./types";

export interface SandboxPolicyInput {
  readonly root: string;
  readonly git: GitLayout;
  readonly featurePrdPaths: readonly string[];
  readonly credentialFiles: readonly string[];
  readonly approvalsFile?: string;
  readonly home: string;
  readonly tempRoots: readonly string[];
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
  const hooksAndConfig = [join(common, "hooks"), join(common, "config")];
  if (git.kind === "main") return hooksAndConfig;
  // A worktree's `.git` is a pointer FILE, and gitdir/commondir point back;
  // repointing any of them at an agent-written config (core.hooksPath) would
  // make nax's own unsandboxed git run hooks (spec 12, finding 4).
  return [...hooksAndConfig, join(root, ".git"), join(git.gitDir, "gitdir"), join(git.gitDir, "commondir")];
}

export function buildSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const { root, home, config } = input;
  const writeRoots = literal([
    root,
    ...(input.git.kind === "worktree" ? [input.git.commonDir] : []),
    ...input.tempRoots,
    ...(input.platform === "darwin" ? [SRT_MACOS_TMPDIR, join(home, MACOS_CACHE_WRITE_ROOT)] : []),
    ...BUILTIN_CACHE_WRITE_ROOTS.map((rel) => join(home, rel)),
    ...config.filesystem.allowWrite.map((p) => {
      const expanded = expandHome(p, home);
      return isAbsolute(expanded) ? expanded : resolve(root, expanded);
    }),
  ]);
  const denyWrite = literal([
    join(root, ".nax", "config.json"),
    join(root, ".nax", "mono"),
    ...input.featurePrdPaths,
    ...[...QUEUE_CONTROL_FILES].map((name) => join(root, name)),
    ...gitDenies(root, input.git),
    ...(input.approvalsFile !== undefined ? [input.approvalsFile] : []),
  ]);
  const denyRead = literal([
    ...BUILTIN_CREDENTIAL_READ_DENIES.map((rel) => join(home, rel)),
    ...input.credentialFiles,
    ...config.filesystem.denyRead.map((p) => resolve(root, expandHome(p, home))),
  ]);
  const allowed = config.network.allowedDomains;
  return { writeRoots, denyWrite, denyRead, network: allowed === undefined ? {} : { allowedDomains: [...allowed] } };
}
