/**
 * Auto-PR Plugin — Types
 *
 * Config and dependency-injection shapes used by the auto-PR post-run action.
 *
 * Pure types only — no I/O or runtime behavior lives here.
 */

/** Forge identifier for the host repository. */
export type ForgeKind = "github" | "gitlab";

/** Configuration surface for `autoPr` in `nax.config.json`. */
export interface AutoPrConfig {
  /** Whether auto-PR creation is enabled (default: false) */
  enabled: boolean;
  /** Whether to create the PR as a draft (default: true) */
  draft: boolean;
}

/** Dependencies injected into the plugin so tests can swap fs/subprocess access. */
export interface AutoPrDeps {
  /**
   * Run a subprocess and capture its exit code + output streams.
   *
   * @param cmd - Argv array passed verbatim to the OS
   * @param opts - Working-directory and execution options
   */
  run(cmd: string[], opts: { cwd: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  /**
   * Read a UTF-8 file from disk.
   *
   * @param path - Absolute path to read
   * @returns File contents, or `null` if the file does not exist
   */
  readText(path: string): Promise<string | null>;
}
