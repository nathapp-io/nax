/**
 * The process-spawning contract the spawn cases exercise, mirrored structurally
 * from nax-agent's `AgentRuntime` (src/runtime/types.ts). test-kit depends on no
 * nax package, so it cannot import that type; any runtime matching this shape
 * can run the cases. Runner-neutral: no bun:test, vitest or Bun types.
 */
export interface CaseSpawnResult {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  readonly pid: number;
  readonly stdin?: { write(data: string | Uint8Array): number; end(): void; flush(): void };
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface CaseRuntime {
  spawn(
    cmd: readonly string[],
    opts: {
      cwd?: string;
      stdin?: "pipe" | "inherit";
      stdout: "pipe";
      stderr: "pipe" | "inherit";
      env?: Record<string, string | undefined>;
      detached?: boolean;
    },
  ): CaseSpawnResult;
}

/** Runner-neutral glob contract; intentionally independent of spawn cases. */
export interface CaseGlobRuntime {
  glob(pattern: string, opts: { cwd: string; absolute: boolean }): AsyncIterable<string>;
  globSync(pattern: string, opts: { cwd: string; absolute: boolean }): Iterable<string>;
}
