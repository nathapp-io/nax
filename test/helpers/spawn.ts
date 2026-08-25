/**
 * Typed spawn stubs.
 *
 * `typeof Bun.spawn` is a heavily overloaded generic and `Subprocess` carries a
 * dozen members no test cares about, so no plain function or object literal can
 * satisfy either. Every fake used to assert its way past that — 186 assertions
 * across 80+ files (#1514 phase 3c) — then two, contained here.
 *
 * Now neither is an assertion. Both factories declare the public signature as
 * an overload and leave the implementation signature loose, which is the
 * language's own mechanism for exactly this: callers still get `SpawnStub` and
 * `SpawnResult`, while the body returns the mock and the literal it really
 * built.
 *
 * The literal is not checked against `Subprocess`, and the assertion it
 * replaced did not check it either — a cast through `unknown` checks nothing.
 * Adding `satisfies Partial<Subprocess>` here does compile and is the way to
 * get that checking, but it currently reports three genuine divergences in the
 * fake (`stdin: null` against `number | FileSink | undefined`, and the two
 * streams' `Uint8Array<ArrayBufferLike>` against `Uint8Array<ArrayBuffer>`).
 * Conforming them changes what the fake hands the code under test, so it is a
 * separate change from removing the assertions.
 *
 * Every `_xDeps.spawn` in src/ is declared `spawn as typeof spawn` off
 * `src/utils/bun-deps`, so a stub typed as `typeof Bun.spawn` is assignable to
 * all of them.
 *
 *   _gitDeps.spawn = makeSpawn(({ cmd }) =>
 *     cmd.includes("rev-parse") ? "/repo\n" : "",
 *   ).spawn;
 */
import { mock } from "bun:test";
import type { Subprocess } from "bun";

/** What `Bun.spawn` returns, as the source code consumes it. */
export type SpawnResult = ReturnType<typeof Bun.spawn>;

/** The subset of a subprocess that nax's source actually reads. */
export interface FakeProcSpec {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  pid?: number;
  /** `exited` never settles — for deadline and SIGKILL-contract tests. */
  hang?: boolean;
  /**
   * `kill()` resolves `exited` with 137 (128 + SIGKILL) — real Bun.spawn
   * behaviour, needed by tests that assert the SIGKILL contract end-to-end.
   */
  killResolvesExited?: boolean;
  /** `stdout` stream errors immediately — for read-error contract tests. */
  stdoutError?: Error;
}

/** One recorded `spawn()` call. */
export interface SpawnCall {
  cmd: string[];
  opts: Record<string, unknown>;
}

export interface SpawnStub {
  /** Assignable to `Bun.spawn` and to every `_xDeps.spawn` in src/. */
  spawn: typeof Bun.spawn;
  /** Every call, in order. */
  calls: SpawnCall[];
  /** The most recent call's resolved `env`, for env-plumbing assertions. */
  lastEnv(): Record<string, string | undefined>;
}

function toSpec(result: FakeProcSpec | string): FakeProcSpec {
  return typeof result === "string" ? { stdout: result } : result;
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function errorStream(err: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.error(err);
    },
  });
}

/**
 * A fake `Subprocess` typed as what `Bun.spawn` returns.
 *
 * Pass a string for the common "just give me this stdout" case.
 */
export function makeSpawnResult(result?: FakeProcSpec | string): SpawnResult;
export function makeSpawnResult(result: FakeProcSpec | string = {}): unknown {
  const spec = toSpec(result);
  const exitCode = spec.exitCode ?? 0;
  let killed = false;
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });
  if (spec.hang !== true) resolveExited(exitCode);
  const proc = {
    stdout: spec.stdoutError !== undefined ? errorStream(spec.stdoutError) : stream(spec.stdout ?? ""),
    stderr: stream(spec.stderr ?? ""),
    stdin: null,
    pid: spec.pid ?? 4242,
    exited,
    exitCode: spec.hang === true ? null : exitCode,
    signalCode: null,
    get killed() {
      return killed;
    },
    success: exitCode === 0,
    kill: () => {
      killed = true;
      if (spec.killResolvesExited === true) resolveExited(137);
    },
    ref: () => {},
    unref: () => {},
    resourceUsage: () => undefined,
  };
  return proc;
}

/**
 * A `spawn` stub typed as `typeof Bun.spawn`, recording every call.
 *
 * `handler` returns the stdout string, a {@link FakeProcSpec}, or a
 * {@link SpawnResult} built by {@link makeSpawnResult}. Omit it for a stub that
 * always succeeds silently.
 */
export function makeSpawn(handler?: (call: SpawnCall) => FakeProcSpec | string | SpawnResult): SpawnStub;
export function makeSpawn(handler: (call: SpawnCall) => FakeProcSpec | string | SpawnResult = () => "") {
  const calls: SpawnCall[] = [];
  const impl = mock((...args: unknown[]): SpawnResult => {
    // Bun.spawn takes either (cmd, opts) or a single options object with `cmd`.
    const first = args[0];
    const call: SpawnCall = Array.isArray(first)
      ? { cmd: first as string[], opts: (args[1] as Record<string, unknown>) ?? {} }
      : {
          cmd: ((first as { cmd?: string[] })?.cmd ?? []) as string[],
          opts: (first as Record<string, unknown>) ?? {},
        };
    calls.push(call);
    const result = handler(call);
    return typeof result === "string" || !("exited" in result) ? makeSpawnResult(result) : result;
  });
  return {
    spawn: impl,
    calls,
    lastEnv: () => (calls.at(-1)?.opts.env ?? {}) as Record<string, string | undefined>,
  };
}
