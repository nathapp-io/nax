/**
 * The approvals cache as the FIRST link of the ask chain (P2 design 4.3, 6.6).
 *
 * TRUST BOUNDARY. Living outside repoRoot protects this file from the TYPED
 * path-bearing tools, but NOT from Bash: nax-owned-writes.ts:52-58 excludes
 * Bash by design, and under `raw` mode screenRawBashCommand's protectedHit
 * skips every path outside the root (policy-bash-raw.ts:84), so the file is
 * never screened. A raw shell can forge entries.
 *
 * That is not a new vulnerability -- a raw shell needs no forged permission to
 * run a command -- but it IS a cross-stage escalation in a MIXED-mode run,
 * where a raw stage poisons the cache an escalate stage later trusts. Hence
 * precondition 1. P4's sandbox closes the underlying hole when enabled: see
 * `sandboxEnabled`.
 *
 * Both preconditions fail by ABSTAINING, which escalates to the human, so a
 * failure costs prompts rather than safety.
 */
import { relative, resolve } from "node:path";
import { getSafeLogger } from "../logger";
import { findApproval, readApprovals } from "./approvals-store";
import type { AskLink, AskLinkOutcome } from "./ask-chain";
import type { AskRequest } from "./types";

const ABSTAIN: AskLinkOutcome = { decision: "abstain", decidedBy: "cache" };

function insideRepo(repoRoot: string, file: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(file));
  return rel !== "" && !rel.startsWith("..");
}

export function createApprovalsLink(opts: {
  readonly approvalsFile: string;
  readonly repoRoot: string;
  /** Every stage's resolved bashApproval mode in this run. */
  readonly stageModes: readonly string[];
  /**
   * `execution.sandbox.enabled` (P4). With the sandbox enabled a raw stage is
   * either wrapped -- and the approvals file is ALWAYS in its denyWrite, even
   * when outputDir puts it inside a write root -- or refused outright, so it
   * cannot forge this file. Config-only by design: no dependency on the probe.
   */
  readonly sandboxEnabled: boolean;
}): AskLink {
  const rawStage = opts.stageModes.includes("raw") && !opts.sandboxEnabled;
  const inRepo = insideRepo(opts.repoRoot, opts.approvalsFile);
  const disabled = rawStage || inRepo;

  if (disabled) {
    getSafeLogger()?.warn("permissions", "[approvals] cache disabled; every ask reaches the human", {
      reason: rawStage
        ? "a stage resolves to bashApproval:raw without the sandbox, which can forge this file"
        : "approvals file is inside repoRoot",
      approvalsFile: opts.approvalsFile,
    });
  }

  return {
    name: "approvals-cache",
    async resolve(req: AskRequest): Promise<AskLinkOutcome> {
      if (disabled) return ABSTAIN;
      if (req.command === undefined) return ABSTAIN;
      const hit = findApproval(await readApprovals(opts.approvalsFile), req.stage, req.command);
      return hit === undefined ? ABSTAIN : { decision: "allow", decidedBy: "cache" };
    },
  };
}
