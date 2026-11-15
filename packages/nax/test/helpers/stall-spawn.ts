/**
 * Fixtures for a gate command that repeats one output line while its exit never
 * settles — the shape the stall detector exists for.
 *
 * Shared by the verification-runner list tests and the test-operation routing
 * tests (US-004), which both need a *live* child whose repetition alone ends the
 * invocation, on either stream, without a real wall-clock wait.
 *
 * ```ts
 * const proc = stalledProc("stdout");
 * const stub = makeSpawn(({ cmd }) => (cmd[2] === "hangs" ? proc : { exitCode: 0 }));
 * ```
 */
import type { SpawnResult } from "./spawn";
import { makeSpawnResult } from "./spawn";

/** The line a stalled child repeats; its exact text is not meaningful. */
export const STALL_REPEAT_LINE = "stuck line";

/** A closed stream carrying `count` equal, newline-terminated lines. */
export function repeatedLinesStream(count: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(`${STALL_REPEAT_LINE}\n`.repeat(count));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * A live child (its `exited` never settles) repeating `STALL_REPEAT_LINE` on one
 * stream. With a policy threshold at or below `count`, the detector — not a wall
 * deadline — is what ends this invocation.
 */
export function stalledProc(stream: "stdout" | "stderr", count: number): SpawnResult {
  const proc = makeSpawnResult({ hang: true });
  Object.defineProperty(proc, stream, { value: repeatedLinesStream(count) });
  return proc;
}
