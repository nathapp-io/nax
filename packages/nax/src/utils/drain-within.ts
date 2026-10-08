/**
 * A stream drain with a deadline.
 *
 * After a process exits, a descendant that escaped its process group can still
 * hold the pipe's write end, so `new Response(stream).text()` may never settle.
 * Callers that already know the process is gone give the drain a fixed window,
 * then move on with nothing rather than wedging (quality/runner.ts and
 * hooks/runner.ts bound their post-kill drains the same way).
 */
export async function drainWithin(drain: Promise<string>, deadlineMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve(""), deadlineMs);
  });
  try {
    return await Promise.race([drain, expired]);
  } finally {
    clearTimeout(timer);
  }
}
