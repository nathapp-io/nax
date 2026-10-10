/**
 * Context Engine v2 — AdvisorDecisionsProvider (A1 spec §4.9, §12.2).
 *
 * Repo-scoped, push-style. Reads the feature's advisor ledger through the
 * trusted read (a line counts only when its audit artifact exists under
 * `request.outputDir`) and emits one chunk per decision that bears on the
 * requested story: its own decisions, a supersede of one of its ACs, or any
 * supersede of a spec section. This is how a ruling reaches the retried fix
 * dispatch and later stories. Chunks are `kind: "feature"` so the budget never
 * drops them.
 *
 * Failure handling: no feature, no outputDir, no ledger, or a read error →
 * empty chunks; never throws.
 */
import { createHash } from "node:crypto";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdviceDecision } from "@/advisor/store";
import { describeTarget, isPromptSafe, readTrustedDecisions } from "@/advisor/store";
import { getLogger } from "@/logger";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

export const _advisorDecisionsDeps = { readTrustedDecisions };

function bearsOn(d: AdviceDecision, storyId: string | undefined): boolean {
  if (d.action.type === "supersede") {
    return d.action.target.kind === "spec" || d.action.target.storyId === storyId;
  }
  return storyId !== undefined && d.storyId === storyId;
}

function render(d: AdviceDecision): string {
  const a = d.action;
  if (a.type === "supersede") {
    return `${describeTarget(a.target)} is superseded by advisor decision ${d.id}: ${a.newText} (reason: ${d.rationale})`;
  }
  const detail = "instruction" in a ? a.instruction : "reason" in a ? a.reason : "";
  return `Advisor decision ${d.id} (${a.type}): ${d.rationale}${detail ? ` — ${detail}` : ""}`;
}

function toChunk(d: AdviceDecision): RawChunk {
  const content = render(d);
  return {
    id: `advisor-decisions:${createHash("sha256").update(content).digest("hex").slice(0, 8)}`,
    kind: "feature",
    scope: "story",
    role: ["implementer", "reviewer"],
    content,
    tokens: Math.ceil(content.length / 4),
    rawScore: 1.0,
  };
}

export class AdvisorDecisionsProvider implements IContextProvider {
  readonly id = "advisor-decisions" as const;
  readonly kind = "feature" as const;

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    if (!request.featureId || !request.outputDir) return { chunks: [], pullTools: [] };
    try {
      const decisions = await _advisorDecisionsDeps.readTrustedDecisions(
        request.repoRoot,
        request.featureId,
        request.outputDir,
      );
      return {
        chunks: decisions.filter((d) => isPromptSafe(d) && bearsOn(d, request.storyId)).map(toChunk),
        pullTools: [],
      };
    } catch (err) {
      getLogger().warn("advisor-decisions", "Reading advisor decisions failed — no chunks", {
        storyId: request.storyId ?? "_run",
        error: errorMessage(err),
      });
      return { chunks: [], pullTools: [] };
    }
  }
}
