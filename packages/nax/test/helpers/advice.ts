/**
 * Advisor fixtures — complete `AdviceQuestion` / `AdviceDecision` defaults so a
 * test sets only the fields it asserts on, without a partial-object cast.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdviceDecision, AdviceQuestion } from "@/advisor";
import { ledgerPath } from "@/advisor";

export function makeAdviceQuestion(overrides: Partial<AdviceQuestion> = {}): AdviceQuestion {
  return {
    id: "Q-1",
    kind: "finish-judgment",
    feature: "feat",
    askedAtSha: "sha",
    summary: "",
    evidence: [],
    options: [],
    ...overrides,
  };
}

export function makeAdviceDecision(overrides: Partial<AdviceDecision> = {}): AdviceDecision {
  return {
    id: "D-1",
    questionId: "Q-1",
    kind: "finish-judgment",
    chosenOptionId: "A",
    action: { type: "approve" },
    rationale: "",
    confidence: "high",
    reversible: true,
    needsHumanConfirm: false,
    decidedAt: "2026-10-10T00:00:00.000Z",
    model: "m",
    memoryMode: "stateless",
    auditRef: "advisor-audit/feat/D-1.json",
    ...overrides,
  };
}

/**
 * Appends `decision` to the feature's advisor ledger and writes the audit artifact that makes
 * `readTrustedDecisions` accept it: `<outputDir>/<auditRef>` recording this very decision.
 */
export async function writeTrustedDecision(
  repoRoot: string,
  feature: string,
  outputDir: string,
  decision: AdviceDecision,
): Promise<void> {
  const ledger = ledgerPath(repoRoot, feature);
  await mkdir(dirname(ledger), { recursive: true });
  await appendFile(ledger, `${JSON.stringify(decision)}\n`);
  await Bun.write(join(outputDir, decision.auditRef), JSON.stringify({ result: { decision } }));
}
