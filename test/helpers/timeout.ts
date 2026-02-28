/**
 * Test Timeout Helpers
 *
 * Utilities to prevent tests from hanging indefinitely.
 */

/**
 * Wraps a promise with a hard timeout.
 * If the promise doesn't resolve within the timeout, rejects with a timeout error.
 *
 * @param promise The promise to wrap
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation (for error messages)
 * @returns The promise result if it completes in time
 * @throws TimeoutError if the timeout is exceeded
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string = "Operation"
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

/**
 * Wraps a function call with a hard timeout.
 * Useful for wrapping synchronous or async functions that might hang.
 *
 * @param fn The function to execute
 * @param timeoutMs Timeout in milliseconds
 * @param operation Description of the operation (for error messages)
 * @returns The function result if it completes in time
 * @throws TimeoutError if the timeout is exceeded
 */
export async function executeWithTimeout<T>(
  fn: () => Promise<T> | T,
  timeoutMs: number,
  operation: string = "Operation"
): Promise<T> {
  return withTimeout(Promise.resolve(fn()), timeoutMs, operation);
}
