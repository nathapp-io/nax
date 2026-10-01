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
 * The file is project-scoped and OUTLIVES the run, so precondition 1 covers
 * only THIS run: an EARLIER forge-capable run could have written it (#2199).
 * Precondition 3 covers that history: a tainted store is never trusted (see
 * approvals-taint.ts, which also states the residual risk). Entry `root` is
 * compared with the project root too, but only as hygiene -- a forger
 * controls `root`.
 *
 * Every precondition fails by ABSTAINING, which escalates to the human, so a
 * failure costs prompts rather than safety.
 */
import { relative, resolve } from "node:path";
import { getSafeLogger } from "../logger";
import { findApproval, readApprovalsFile } from "./approvals-store";
import { isForgeCapable } from "./approvals-taint";
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
  /**
   * The project root (`ctx.projectDir`). An entry is honoured only when its
   * `root` is this root or lies inside it, as worktrees and package dirs do.
   */
  readonly projectRoot: string;
  /** Every stage's resolved bashApproval mode in this run. */
  readonly stageModes: readonly string[];
  /**
   * `execution.sandbox.enabled` (P4). With the sandbox enabled a raw stage is
   * either wrapped -- and the approvals file is ALWAYS in its denyWrite, even
   * when outputDir puts it inside a write root -- or refused outright, so it
   * cannot forge this file DURING THIS RUN. What earlier runs wrote is
   * precondition 3's job. Config-only by design: no dependency on the probe.
   */
  readonly sandboxEnabled: boolean;
}): AskLink {
  const rawStage = isForgeCapable(opts.stageModes, opts.sandboxEnabled);
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
      // Read per ask: a concurrent forge-capable run can taint the store mid-run.
      const store = await readApprovalsFile(opts.approvalsFile);
      if (store.taint !== undefined) return ABSTAIN;
      const hit = findApproval(store.entries, req.stage, req.command, opts.projectRoot);
      return hit === undefined ? ABSTAIN : { decision: "allow", decidedBy: "cache" };
    },
  };
}
