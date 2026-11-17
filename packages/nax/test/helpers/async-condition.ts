/** Bounded polling for external PTY/IPC conditions; no work continues after timeout. */
export async function waitForAsyncCondition<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Condition timed out: ${JSON.stringify(value)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
