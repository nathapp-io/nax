/**
 * Typed spawn stubs.
 *
 * `typeof Bun.spawn` is a heavily overloaded generic, and `Subprocess` carries
 * a dozen members no test cares about, so every fake used to end in
 * `as unknown as typeof Bun.spawn` / `as unknown as ReturnType<typeof Bun.spawn>`.
 * That was 186 casts across 80+ files (#1514 phase 3c). The two casts live here
 * now, once, behind a signature that says what the fake actually is.
 *
 * Every `_xDeps.spawn` in src/ is declared `spawn as typeof spawn` off
 * `src/utils/bun-deps`, so a stub typed as `typeof Bun.spawn` is assignable to
 * all of them.
 *
 *   _gitDeps.spawn = makeSpawn(({ cmd }) =>
 *     cmd.includes("rev-parse") ? "/repo\n" : "",
 *   ).spawn;
 */
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

/**
 * A fake `Subprocess` typed as what `Bun.spawn` returns.
 *
 * Pass a string for the common "just give me this stdout" case.
 */
export function makeSpawnResult(result: FakeProcSpec | string = {}): SpawnResult {
  const spec = toSpec(result);
  const exitCode = spec.exitCode ?? 0;
  let killed = false;
  const proc = {
    stdout: stream(spec.stdout ?? ""),
    stderr: stream(spec.stderr ?? ""),
    stdin: null,
    pid: spec.pid ?? 4242,
    exited: spec.hang === true ? new Promise<number>(() => {}) : Promise.resolve(exitCode),
    exitCode: spec.hang === true ? null : exitCode,
    signalCode: null,
    get killed() {
      return killed;
    },
    success: exitCode === 0,
    kill: () => {
      killed = true;
    },
    ref: () => {},
    unref: () => {},
    resourceUsage: () => undefined,
  };
  // The one cast for the subprocess shape. A real Subprocess has members no
  // test exercises; widen through Subprocess so the fields above are still
  // checked against it.
  return proc as unknown as Subprocess as SpawnResult;
}

/**
 * A `spawn` stub typed as `typeof Bun.spawn`, recording every call.
 *
 * `handler` returns the stdout string, a {@link FakeProcSpec}, or a
 * {@link SpawnResult} built by {@link makeSpawnResult}. Omit it for a stub that
 * always succeeds silently.
 */
export function makeSpawn(handler: (call: SpawnCall) => FakeProcSpec | string | SpawnResult = () => ""): SpawnStub {
  const calls: SpawnCall[] = [];
  const impl = (...args: unknown[]): SpawnResult => {
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
  };
  return {
    // The one cast for the function shape: `typeof Bun.spawn` is a set of
    // generic overloads no plain function literal can satisfy.
    spawn: impl as unknown as typeof Bun.spawn,
    calls,
    lastEnv: () => (calls.at(-1)?.opts.env ?? {}) as Record<string, string | undefined>,
  };
}
