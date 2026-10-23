/** Shared bounded polling for the forge to publish a pushed PR head. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { defaultForgeDeps, type PrRef, readPrInfo } from "@/forge";
import { getLogger } from "@/logger";

export const PR_HEAD_POLL_MS = 5_000;
export const PR_HEAD_WAIT_MS = 60_000;
export const _prHeadWaitDeps = {
  readPrInfo,
  forge: defaultForgeDeps,
  sleep: (ms: number): Promise<void> => Bun.sleep(ms),
  now: () => Date.now(),
};

export async function waitForPrHead(
  input: { ref: PrRef; repoRoot: string; sha: string },
  deps = _prHeadWaitDeps,
): Promise<boolean> {
  const deadline = deps.now() + PR_HEAD_WAIT_MS;
  while (true) {
    try {
      const info = await deps.readPrInfo(input.ref, deps.forge, input.repoRoot);
      if (info.headSha === input.sha) return true;
    } catch (error) {
      getLogger()?.warn("bot-fix", "Could not read PR head; retrying within poll window", {
        pr: input.ref.number,
        error: errorMessage(error),
      });
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return false;
    await deps.sleep(Math.min(PR_HEAD_POLL_MS, remaining));
  }
}
