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
];
