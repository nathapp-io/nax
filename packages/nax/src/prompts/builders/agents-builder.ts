import type { AgentResource } from "@/resources";
import { chatPermissionParagraph } from "./chat-builder";
import { buildRulesIndexSection, type RulesIndexEntry } from "./rules-index-builder";
import { cleanIndexDescription } from "./skills-builder";

export const MAX_AGENTS_INDEX_ENTRIES = 150;

export interface SubagentInstructionsInput {
  readonly agent: Pick<AgentResource, "prompt">;
  readonly mode: "full" | "guarded";
  readonly rulesIndex: readonly RulesIndexEntry[];
}

/** Advertise available agents without inlining their prompts. */
export function buildAgentsInstructions(entries: readonly { qualifiedName: string; description: string }[]): string {
  const lines = [
    "When a task suits one of these agents, call nax-agents__run with the agent name and a self-contained task.",
  ];
  for (const entry of entries.slice(0, MAX_AGENTS_INDEX_ENTRIES)) {
    lines.push(`- ${entry.qualifiedName}: ${cleanIndexDescription(entry.description)}`);
  }
  if (entries.length > MAX_AGENTS_INDEX_ENTRIES) {
    lines.push(`- ... and ${entries.length - MAX_AGENTS_INDEX_ENTRIES} more`);
  }
  return lines.join("\n");
}

/** System instructions of a nested agent session: permissions, rules index, then the agent's own prompt. */
export function buildSubagentInstructions(input: SubagentInstructionsInput): string {
  const sections = [chatPermissionParagraph(input.mode)];
  const rules = buildRulesIndexSection({ entries: input.rulesIndex, shownAutomatically: true });
  if (rules) sections.push(rules);
  sections.push(input.agent.prompt);
  return sections.join("\n\n");
}
