/**
 * Shared injectable Bun primitives.
 *
 * Import these into your module's _deps object instead of
 * re-declaring Bun.spawn / Bun.which / Bun.sleep wrappers.
 *
 * Tests mock the consuming module's _deps — NOT this file.
 */

/** Typed spawn return (covers all agent adapter use cases) */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  pid: number;
  stdin?: { write(data: string | Uint8Array): number; end(): void; flush(): void };
  kill(signal?: number | NodeJS.Signals): void;
}

/** Spawn options union covering all current call sites */
export interface SpawnOptions {
  cwd?: string;
  stdin?: "pipe" | "inherit";
  stdout: "pipe";
  stderr: "pipe" | "inherit";
  env?: Record<string, string | undefined>;
}

/** Injectable typed spawn — wraps Bun.spawn with proper return type */
export function typedSpawn(cmd: string[], opts: SpawnOptions): SpawnResult {
  return Bun.spawn(cmd, opts) as unknown as SpawnResult;
}

/** Injectable which — wraps Bun.which */
export function which(name: string): string | null {
  return Bun.which(name);
}

/** Injectable sleep — wraps Bun.sleep */
export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms);
}

/** Injectable file — wraps Bun.file */
export function file(path: string) {
  return Bun.file(path);
}

/** Injectable spawn (simple, untyped — for git/process use cases) */
export const spawn = Bun.spawn as typeof Bun.spawn;
