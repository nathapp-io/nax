/** Repo-scoped checkout-write exclusion while plan/run jobs are active. */
import type { LoopHandlerSet } from "@nathapp/nax-agent";
import type { ChatJobs } from "./job-runner";

export const GUARDED_WRITE_TOOLS: readonly string[] = Object.freeze(["Write", "Edit", "Delete", "GitCommit"]);

export function createJobWriteGuard(jobs: Pick<ChatJobs, "running">, repoRoot: string): LoopHandlerSet {
  return Object.freeze([
    {
      plugin: "nax-jobs",
      event: "before_tool",
      handler: (payload) => {
        if (!("call" in payload) || !GUARDED_WRITE_TOOLS.includes(payload.call.name)) return { kind: "allow" };
        const job = jobs
          .running()
          .filter((job) => job.cwd === repoRoot && (job.kind === "plan" || job.kind === "run"))
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
        if (!job) return { kind: "allow" };
        return {
          kind: "block",
          isError: true,
          content: `[nax-jobs] ${payload.call.name} refused: nax ${job.kind} job ${job.id} is running in this checkout; wait for it to end or cancel it`,
        };
      },
    },
  ] satisfies LoopHandlerSet);
}
