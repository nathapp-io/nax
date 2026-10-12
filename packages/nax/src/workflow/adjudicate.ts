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
  const byId = new Map(answer.rulings.filter((r) => r.findingId).map((r) => [r.findingId as string, r]));
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
