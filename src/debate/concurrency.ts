/**
 * Debate Concurrency Utilities
 *
 * Bounded parallel execution for debate rounds.
 */

/**
 * Run tasks with bounded concurrency, returning all results as PromiseSettledResult.
 *
 * Equivalent to Promise.allSettled but limits the number of concurrent in-flight tasks.
 * A rejected task does not abort remaining tasks.
 *
 * @param tasks - Array of task factories (thunks). Called lazily as slots open.
 * @param limit - Maximum number of concurrent in-flight tasks (min 1).
 */
export async function allSettledBounded<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return [];

  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const concurrency = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
