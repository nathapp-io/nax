import { findingKey } from "@/findings";
import type { Finding, FixStrategy, Iteration } from "@/findings";

function madeNoProgress(iteration: Iteration<Finding>): boolean {
  if (iteration.findingsBefore.length === 0) return false;
  const after = new Set(iteration.findingsAfter.map(findingKey));
  return iteration.findingsBefore.every((finding) => after.has(findingKey(finding)));
}

export function withNoProgressBail(
  strategies: FixStrategy<Finding, unknown, unknown, unknown>[],
  enabled: boolean,
  consecutiveNoProgress: number,
): FixStrategy<Finding, unknown, unknown, unknown>[] {
  if (!enabled) return strategies;
  const threshold = Math.max(1, consecutiveNoProgress);
  return strategies.map((strategy) => ({
    ...strategy,
    bailWhen: (iterations: Iteration<Finding>[]): string | null => {
      const userReason = strategy.bailWhen?.(iterations) ?? null;
      if (userReason !== null) return userReason;
      if (iterations.length < threshold) return null;
      const trailing = iterations.slice(-threshold);
      if (!trailing.every(madeNoProgress)) return null;
      return `no finding resolved for ${threshold} consecutive iteration(s); ${trailing.at(-1)?.findingsBefore.length ?? 0} finding(s) persisted`;
    },
  }));
}
