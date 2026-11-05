import type { AgentResource } from "@/resources";
import { chatPermissionParagraph } from "./chat-builder";
import { memorySectionOf } from "./memory-builder";
import { buildRulesIndexSection, type RulesIndexEntry } from "./rules-index-builder";
import { cleanIndexDescription } from "./skills-builder";

export const MAX_AGENTS_INDEX_ENTRIES = 150;

export interface SubagentInstructionsInput {
  readonly agent: Pick<AgentResource, "prompt">;
  readonly mode: "full" | "guarded";
  readonly rulesIndex: readonly RulesIndexEntry[];
  /** The rendered memory index; placed before the agent's own prompt when present and non-empty. */
  readonly memoryIndex?: string;
}

/** Advertise available agents without inlining their prompts. */
export function buildAgentsInstructions(entries: readonly { qualifiedName: string; description: string }[]): string {
  const lines = [
    "When a task suits one of these agents, call nax-agents__run with the agent name and a self-contained task.",
    "Pass model to run an agent on another model: provider/model for the nax native agent (openai-codex/gpt-6-luna is native), acp:<agent> for an installed ACP agent.",
  ];
  for (const entry of entries.slice(0, MAX_AGENTS_INDEX_ENTRIES)) {
    lines.push(`- ${entry.qualifiedName}: ${cleanIndexDescription(entry.description)}`);
  }
  if (entries.length > MAX_AGENTS_INDEX_ENTRIES) {
    lines.push(`- ... and ${entries.length - MAX_AGENTS_INDEX_ENTRIES} more`);
  }
  return lines.join("\n");
}

export interface AcpSubagentInstructionsInput {
  /** Display name of the ACP agent, e.g. "Codex". */
  readonly agentLabel: string;
  readonly agent: Pick<AgentResource, "qualifiedName" | "prompt">;
  /** Rendered instructions of the nax tools delivered to the subagent. */
  readonly toolInstructions?: string;
  /** The rendered memory index; placed before the agent's own prompt when present and non-empty. */
  readonly memoryIndex?: string;
}

/**
 * System instructions of an ACP subagent: what it is, the nax tools it was handed,
 * the memory index, then the agent's own prompt.
 *
 * The agent's own settings apply, so there is no nax rules index — the same reason the
 * ACP chat brain carries none. The closing sentence is what makes a one-shot session
 * usable: the calling chat reads only the final text.
 */
export function buildAcpSubagentInstructions(input: AcpSubagentInstructionsInput): string {
  const sections = [
    `You are ${input.agentLabel}, running as the nax chat subagent ${input.agent.qualifiedName}. Use your own tools for the work. Answer with your final result as text; the chat that called you reads only that.`,
  ];
  if (input.toolInstructions !== undefined && input.toolInstructions !== "") sections.push(input.toolInstructions);
  const memory = memorySectionOf(input.memoryIndex);
  if (memory !== undefined) sections.push(memory);
  sections.push(input.agent.prompt);
  return sections.join("\n\n");
}

/** System instructions of a nested agent session: permissions, rules index, memory index, then the agent's own prompt. */
export function buildSubagentInstructions(input: SubagentInstructionsInput): string {
  const sections = [chatPermissionParagraph(input.mode)];
  const rules = buildRulesIndexSection({ entries: input.rulesIndex, shownAutomatically: true });
  if (rules) sections.push(rules);
  const memory = memorySectionOf(input.memoryIndex);
  if (memory !== undefined) sections.push(memory);
  sections.push(input.agent.prompt);
  return sections.join("\n\n");
}

/**
 * The whole prompt of the built-in general agent: it has no agent file, so it is told
 * what it is and that the caller reads only its last message — the same closing
 * constraint an ACP subagent carries.
 */
export function buildGeneralAgentPrompt(): string {
  return "You are a general-purpose subagent. Complete the task you are given with the tools you have, then reply with a concise final answer: the agent that called you reads only your last message.";
}
