/**
 * Baseline for a red bot gate run (nax#2631). The bot runs gates only after its fix, so a gate
 * already red on the PR head looked like the fix's fault. CI on the exact head is the free,
 * authoritative baseline; a re-run of only the failing gates on the unmodified head catches what CI
 * cannot see: a bot checkout whose environment differs from CI. Both run only when a gate failed.
 */
import type { ForgeKind } from "@/forge";
import { getSafeLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";
import { type GateCommand, type GateRunRecord, gateOutputTail, runQualityGates } from "../finish/gates/quality";
import { type CiWaitResult, readChecksOnce } from "../workflow/ci-wait";
import { readHead } from "../workflow/git";

export const _gateBaselineDeps = {
  runGit: gitWithTimeout,
  readHead,
  runQualityGates,
  readChecksOnce,
  getLogger: getSafeLogger,
};

/** One CI read for the exact head, never a wait: checks for another head read as `unavailable`. */
export function readHeadCi(input: {
  readonly forge: ForgeKind;
  readonly url: string;
  readonly repoRoot: string;
  readonly headSha: string;
}): Promise<CiWaitResult> {
  return _gateBaselineDeps.readChecksOnce(input.forge, input.url, { cwd: input.repoRoot, expectedSha: input.headSha });
}

/** Keeps a red gate's output: the checkout is removed afterwards, so the log is the only record. */
export function logGateFailure(phase: "fix" | "baseline"): (record: GateRunRecord) => void {
  return (record) => {
    if (record.status === "passed") return;
    _gateBaselineDeps.getLogger()?.warn("bot-fix", `Gate ${record.name} ${record.status}`, {
      phase,
      gate: record.name,
      status: record.status,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      tail: gateOutputTail(record.output),
    });
  };
}

/**
 * The gates among `gates` that also fail on the unmodified head, or `undefined` when the head
 * cannot be checked out unmodified: a tracked edit left by the fix's own gate run (a formatter, a
 * snapshot update) would be carried onto the head. The fix commit is restored on every path.
 */
export async function failingOnHead(
  worktree: string,
  headSha: string,
  gates: GateCommand[],
): Promise<readonly string[] | undefined> {
  const deps = _gateBaselineDeps;
  const fixSha = await deps.readHead(worktree);
  const status = await deps.runGit(["status", "--porcelain", "--untracked-files=no"], worktree);
  if (status.exitCode !== 0 || status.stdout.trim() !== "") return undefined;
  const toHead = await deps.runGit(["checkout", "--detach", headSha], worktree);
  if (toHead.exitCode !== 0) return undefined;
  try {
    return (await deps.runQualityGates(worktree, gates, { onGate: logGateFailure("baseline") })).failing;
  } finally {
    // A failed restore leaves the head checked out. Safe while a red gate run ends the graph (report,
    // then dispose); a step that reuses or retains this checkout must check HEAD first.
    const back = await deps.runGit(["checkout", "--detach", fixSha], worktree);
    if (back.exitCode !== 0) {
      deps.getLogger()?.warn("bot-fix", "Could not restore the fix commit after the baseline run", {
        worktree,
        fixSha,
        stderr: back.stderr,
      });
    }
  }
}
