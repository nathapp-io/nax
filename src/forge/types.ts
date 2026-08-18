/**
 * Shared forge (GitHub / GitLab) types.
 *
 * Pure types only. Every subprocess and filesystem call in this module goes
 * through an injected `ForgeDeps` so callers can supply fakes without touching
 * real disk or spawning a process.
 */

/** Forge identifier for the host repository. */
export type ForgeKind = "github" | "gitlab";

/** Captured result of a subprocess run. */
export interface ForgeRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injected I/O for every function in this module. */
export interface ForgeDeps {
  /** Run a subprocess and capture its exit code and output streams. */
  run(cmd: string[], opts: { cwd: string; timeoutMs?: number }): Promise<ForgeRunResult>;
  /** Read a UTF-8 file. Returns null when the file does not exist. */
  readText(path: string): Promise<string | null>;
}
