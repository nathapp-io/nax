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
