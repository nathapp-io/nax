/**
 * Built-in sandbox lists (spec 5.3). One auditable constant each; extend a
 * project's set through `execution.sandbox.filesystem`, not by editing these.
 */

/** Package-manager caches, relative to $HOME. The bun cache is REQUIRED: bun stages temp files there (spec F3). */
export const BUILTIN_CACHE_WRITE_ROOTS: readonly string[] = [
  ".bun/install/cache",
  ".npm",
  ".cache",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  ".pnpm-store",
];

/** macOS-only cache root, relative to $HOME. */
export const MACOS_CACHE_WRITE_ROOT = "Library/Caches";

/** srt forces TMPDIR to this inside the macOS sandbox and does not create it (spec F3). */
export const SRT_MACOS_TMPDIR = "/tmp/claude";

/**
 * #2301 — the same directory as `SRT_MACOS_TMPDIR`, named through macOS's
 * `/tmp` -> `/private/tmp` symlink. srt force-allows both spellings, and which of
 * them survives nax's own `realOrRaw` depends on the host, so a deny names both.
 */
export const SRT_MACOS_TMPDIR_PRIVATE_SPELLING = "/private/tmp/claude";

/**
 * #2301 — both spellings of srt's forced TMPDIR, as a deny list.
 *
 * srt always includes `/tmp/claude` and `/private/tmp/claude` in
 * `SANDBOX_OWN_WRITE_PATHS` and `getDefaultWritePaths` never drops them, so the
 * only way to take the write back is an explicit `denyWrite` — srt renders its
 * allow rules before its deny rules in a macOS profile, where the later deny wins.
 */
export const SRT_MACOS_TMPDIR_DENIES: readonly string[] = [SRT_MACOS_TMPDIR, SRT_MACOS_TMPDIR_PRIVATE_SPELLING];

/**
 * srt's mandatory write-deny FILES, relative to the directory srt resolves them
 * against (`process.cwd()`), mirrored verbatim from
 * `@anthropic-ai/sandbox-runtime` 0.0.77's `DANGEROUS_FILES` — the same pin the
 * package pins as a dependency.
 *
 * srt applies these itself, so nax cannot see them in a policy. On Linux bwrap
 * creates a mount placeholder at every one of them that is absent, which is why
 * the placeholder ledger needs the list: a test (`test/unit/sandbox/placeholder-paths.test.ts`)
 * fails if this array drifts from the pinned srt.
 */
export const SRT_MANDATORY_DENY_FILES: readonly string[] = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
];

/**
 * srt's `getDangerousDirectories()` for 0.0.77: its `DANGEROUS_DIRECTORIES` with
 * `.git` dropped (srt blocks `.git/hooks` and `.git/config` instead, which
 * `candidatePaths` adds itself), plus the two `.claude` subdirectories. Both
 * `.claude` entries are absent together, so both map to the same placeholder.
 */
export const SRT_MANDATORY_DENY_DIRS: readonly string[] = [".vscode", ".idea", ".claude/commands", ".claude/agents"];

/** Credential stores the agent's commands may not read, relative to $HOME. nax's own credential files are listed separately (they live under globalConfigDir()). */
export const BUILTIN_CREDENTIAL_READ_DENIES: readonly string[] = [
  ".ssh",
  ".aws",
  ".config/gcloud",
  ".docker/config.json",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".config/gh",
  ".config/glab-cli",
];
