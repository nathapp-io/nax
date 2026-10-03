/**
 * The process-spawning contract nax-agent's tools run through (spec S2 §4.2).
 * The shape records Bun.spawn's measured behaviour; the Node default
 * (node-runtime.ts) normalises to it, and nax installs Bun.spawn itself.
 *
 * Distinct from nax's own `SpawnOptions`/`SpawnResult` (packages/nax/src/utils/
 * bun-deps.ts), which describe nax's direct Bun.spawn wrapper.
 */
export interface AgentSpawnOptions {
  cwd?: string;
  stdin?: "pipe" | "inherit";
  stdout: "pipe";
  stderr: "pipe" | "inherit";
  /** Replaces the environment; `undefined` values are dropped. Omitted: inherit. */
  env?: Record<string, string | undefined>;
  /** setsid: the child becomes its own process-group leader, so a group kill reaches its descendants (ORPHAN-1). */
  detached?: boolean;
}

export interface AgentSpawnStdin {
  /** Returns the number of bytes written. Never throws for a child that already exited. */
  write(data: string | Uint8Array): number;
  end(): void;
  flush(): void;
}

export interface AgentSpawnResult {
  readonly stdout: ReadableStream<Uint8Array>;
  /** With `stderr: "inherit"` there is nothing to read; callers that inherit never read it. */
  readonly stderr: ReadableStream<Uint8Array>;
  /** The exit code, or 128 + the signal number for a signal exit. Resolves at exit, not when the pipes close. */
  readonly exited: Promise<number>;
  readonly pid: number;
  readonly stdin?: AgentSpawnStdin;
  /** `null` until exit, and after a signal exit. */
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * The slot's contract. `spawn` throws synchronously when the process cannot be
 * started (missing binary, missing or non-directory cwd, not executable).
 */
export interface AgentGlobOptions {
  cwd: string;
  absolute: boolean;
}

export interface AgentRuntime {
  // nax-git-env-allow: the generic spawn contract; git callers (gitWithTimeout) pass hardenedGitEnv themselves
  spawn(cmd: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult;
  /** Files only, no hidden result-relative segments; cwd failures propagate. */
  glob(pattern: string, opts: AgentGlobOptions): AsyncIterable<string>;
  globSync(pattern: string, opts: AgentGlobOptions): Iterable<string>;
}
