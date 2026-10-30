/**
 * Repo-scoped checkout-write exclusion for an ACP brain: while a chat-started plan or run job
 * holds this checkout, an answerable approval for an ACP file-write tool call is refused.
 * Full mode is not guarded: the ACP `full` profile never asks. Shell (`execute`) and `other`
 * tool calls are out of scope.
 */
import type { ChatApproval } from "../ask-controller";
import type { ChatJobs } from "../jobs";
import { isChatAcpModel } from "./acp-model";

/** The ACP tool kinds that write to the checkout. */
export const ACP_WRITE_KINDS: readonly string[] = Object.freeze(["edit", "delete", "move"]);

/** The refusal text for a guarded ACP write, or undefined when the request is not one. */
export function acpWriteRefusal(
  jobs: Pick<ChatJobs, "running">,
  repoRoot: string,
  event: ChatApproval,
): string | undefined {
  if (!ACP_WRITE_KINDS.includes(event.tool)) return undefined;
  // The same newest-blocking-job selection as createJobWriteGuard (sharing it is out of scope).
  const job = jobs
    .running()
    .filter((job) => job.cwd === repoRoot && (job.kind === "plan" || job.kind === "run"))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  if (!job) return undefined;
  return `[nax-jobs] ${event.tool} refused: nax ${job.kind} job ${job.id} is running in this checkout; wait for it to end or cancel it`;
}

/** The host's `refuse`: acpWriteRefusal while the current model is an ACP model and jobs exist, else undefined. */
export function acpRefusal(input: {
  readonly jobs: () => Pick<ChatJobs, "running"> | undefined;
  readonly repoRoot: string;
  readonly model: () => string;
}): (event: ChatApproval) => string | undefined {
  return (event) => {
    if (!isChatAcpModel(input.model())) return undefined;
    const jobs = input.jobs();
    return jobs === undefined ? undefined : acpWriteRefusal(jobs, input.repoRoot, event);
  };
}
