/** A5 PR3: the batched advisor prompt (spec §8) — one call, one answer per item. */
import type { AdviceDecision, AdviceQuestion } from "@/advisor/types";
import { ADVISOR_POLICY, ADVISOR_ROLE, advisorDecisionsBlock, advisorQuestionBlock } from "./advisor-builder";

export interface AdvisorBatchPromptInput {
  readonly kind: "residual" | "preflight";
  readonly summary: string;
  readonly items: readonly AdviceQuestion[];
  readonly redGates: readonly string[];
  readonly storyIds: readonly string[];
  readonly specPath: string;
  readonly prdText: string;
  readonly priorDecisions: readonly AdviceDecision[];
}

const ANSWER_FIELDS = `"optionId": "A", "instruction": "...", "reason": "...", "newText": "...", "rationale": "...", "confidence": "high|medium|low", "reversible": true, "needsHumanConfirm": false`;

function residualBlock(input: AdvisorBatchPromptInput): string {
  const items = input.items.map(advisorQuestionBlock).join("\n\n");
  const gates =
    input.redGates.length > 0
      ? `\n\n## Red gates to diagnose\n${input.redGates.map((g) => `- ${g}`).join("\n")}\nA red gate stays red whatever you rule. Give a short diagnosis for each in "diagnoses".`
      : "";
  return `## The story reached its fix-round cap\n${input.summary}\n\nRule on each open item below. Park an item when the reviewer is wrong (waive) or when it is real but can wait for the branch review (defer). Choose carry only when a later story must act on it, and say exactly what that story must do.\n\n${items}${gates}

## Reply
End your reply with exactly one fenced JSON block, one answer per item id:
\`\`\`json
{"answers": [{"itemId": "Q-...", ${ANSWER_FIELDS}}], "diagnoses": {"<gate>": "..."}}
\`\`\`
Include "instruction" for carry, "reason" for waive/defer/hold. "rationale" is always required.`;
}

function preflightBlock(input: AdvisorBatchPromptInput): string {
  return `## Pre-flight
${input.summary}

Before the first story runs, compare every story's acceptance criteria (AC) with the spec. Stories: ${input.storyIds.join(", ")}.
1. Build an overlap table: for each story, the spec sections that govern it.
2. List every conflict: an AC that contradicts the spec, or two ACs that contradict each other. Cite the AC as {"storyId", "acId"} (AC ids are AC-1, AC-2, … in PRD order) and the spec section by its heading number or title.
3. Rule on each conflict with exactly one option:
   A — follow the AC: the spec section is superseded (give the corrected spec text in newText; needs specSection)
   B — follow the spec: the AC is superseded (give the corrected AC text in newText; needs acRef)
   C — reconcile: rewrite the AC so it satisfies both (newText; needs acRef)
   D — flag for a human: the story runs under a stated default (put the default in reason)
List no conflict you are not sure of. An empty list is a valid answer.

## Reply
End your reply with exactly one fenced JSON block:
\`\`\`json
{"overlap": [{"storyId": "US-001", "specSections": ["3.2"]}], "conflicts": [{"storyIds": ["US-002"], "acRef": {"storyId": "US-002", "acId": "AC-3"}, "specSection": "4.1", "description": "...", ${ANSWER_FIELDS}}]}
\`\`\``;
}

export function buildAdvisorBatchPrompt(input: AdvisorBatchPromptInput): string {
  return [
    ADVISOR_ROLE,
    ADVISOR_POLICY,
    `## Feature\nSpec: ${input.specPath} (read it as needed)\n\nPRD:\n${input.prdText}`,
    advisorDecisionsBlock(input.priorDecisions),
    input.kind === "residual" ? residualBlock(input) : preflightBlock(input),
  ].join("\n\n");
}
