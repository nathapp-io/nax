/** Cap adjudication (spec §6 step 7): one batched residual call per story; a missing or failed answer falls to hold. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { defaultHold, type ResidualAnswer, type ResidualRequest, type WorkflowAdvisor } from "./advisor";
import { ledgerText } from "./ledger";
import type { WorkflowRuling } from "./types";

export async function adjudicateResidual(
  advisor: WorkflowAdvisor,
  req: ResidualRequest,
  ledger: (text: string) => Promise<void>,
): Promise<readonly WorkflowRuling[]> {
  let answer: ResidualAnswer = { rulings: [], diagnoses: {} };
  if (req.items.length > 0 || req.redGates.length > 0) {
    try {
      answer = await advisor.ruleResidual(req);
    } catch (err) {
      getLogger().warn("workflow", "Residual advisor call failed — default hold", {
        storyId: req.storyId,
        error: errorMessage(err),
      });
    }
  }
  const byId = firstRulingPerFinding(req, answer.rulings);
  const rulings = req.items.map((item) => byId.get(item.id) ?? defaultHold(item));
  for (const r of rulings) await ledger(ledgerText.ruling(r));
  for (const gate of req.redGates) {
    const diagnosis = answer.diagnoses[gate];
    await ledger(
      ledgerText.note(
        diagnosis ? `gate ${gate} red at the cap: ${diagnosis}` : `gate ${gate} red at the cap (no diagnosis)`,
      ),
    );
  }
  return rulings;
}

/** First ruling per finding wins; duplicates and rulings on unknown ids are warned about and dropped (P3-R10). */
function firstRulingPerFinding(req: ResidualRequest, rulings: readonly WorkflowRuling[]): Map<string, WorkflowRuling> {
  const known = new Set(req.items.map((i) => i.id));
  const byId = new Map<string, WorkflowRuling>();
  for (const r of rulings) {
    if (!r.findingId || !known.has(r.findingId)) {
      getLogger().warn("workflow", "Advisor ruled on an unknown finding - ignored", {
        storyId: req.storyId,
        findingId: r.findingId ?? "(none)",
      });
    } else if (byId.has(r.findingId)) {
      getLogger().warn("workflow", "Duplicate advisor ruling for a finding - first kept", {
        storyId: req.storyId,
        findingId: r.findingId,
      });
    } else {
      byId.set(r.findingId, r);
    }
  }
  return byId;
}
