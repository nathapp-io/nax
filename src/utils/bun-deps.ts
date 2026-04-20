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

/**
 * Cancellable delay — `setTimeout`-based replacement for `Bun.sleep`.
 *
 * Without a signal, behaves identically to `Bun.sleep(ms)`. With an `AbortSignal`,
 * aborting rejects the promise with `signal.reason` (or a generic Error if none)
 * and clears the underlying timer instead of waiting the full delay.
 *
 * This is the canonical implementation of the pattern documented in
 * `docs/architecture/coding-standards.md` §6 "Stream Cancellation". It is a
 * documented exception to `.claude/rules/forbidden-patterns.md`'s ban on
 * `setTimeout`-for-delays — the exception clause permits it precisely when the
 * timer handle must be cancelled mid-flight via `clearTimeout`.
 *
 * Prefer this over `sleep()` at any site where:
 * - The delay is part of a retry/backoff loop that should respect aborts.
 * - The caller has access to an `AbortSignal` (or might in the future).
 *
 * When in doubt, reach for this helper rather than rolling the pattern inline.
 */
export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("delay aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("delay aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Injectable file — wraps Bun.file */
export function file(path: string) {
  return Bun.file(path);
}

/** Injectable spawn (simple, untyped — for git/process use cases) */
export const spawn = Bun.spawn as typeof Bun.spawn;
