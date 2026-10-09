/**
 * After close(), wait for an MCP stdio child to exit (S5-5 spec §3.1, I1). The
 * SDK ends stdin, then SIGTERM after 2 s, then SIGKILL after 2 s more, on
 * unref()'d timers: a server process exiting in between could orphan the child.
 * These timers are ref'd, and after graceMs the child is SIGKILLed here.
 */
import { isProcessAlive } from "#src/internal/process-alive";

const POLL_MS = 25;
const AFTER_KILL_MS = 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(gone: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (gone()) return true;
    await sleep(POLL_MS);
  }
  return gone();
}

export async function waitForStdioExit(pid: number, exited: () => boolean, graceMs: number): Promise<void> {
  const gone = (): boolean => exited() || !isProcessAlive(pid);
  if (await waitUntil(gone, graceMs)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return; // ESRCH: it exited between the probe and the kill
  }
  await waitUntil(gone, AFTER_KILL_MS);
}
