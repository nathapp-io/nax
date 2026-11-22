import type { AgentResource } from "@/resources";
import { chatPermissionParagraph } from "./chat-builder";
import { memorySectionOf } from "./memory-builder";
import { buildRulesIndexSection, type RulesIndexEntry } from "./rules-index-builder";
import { cleanIndexDescription } from "./skills-builder";

export const MAX_AGENTS_INDEX_ENTRIES = 150;

/**
 * The sentence that advertises the built-in explore agent. It is appended to the general
 * line and to the `run` tool's description, so the instruction line count does not move.
 */
export const EXPLORE_SENTENCE = "For read-only code search, pass agent explore: it has Read, Glob, Grep and Git only.";

/**
 * The background default, appended to the first instruction line when the chat can start a
 * background run, so the line count does not move.
 */
export const BACKGROUND_DEFAULT_SENTENCE =
  "A run starts in the background by default: it returns at once with a task id, keeps running after your turn ends, and a notice arrives when it ends. Pass runInBackground: false only when you need the agent's answer before you can continue in this same turn.";

export interface AgentsInstructionsOptions {
  /** True when a run with no flag starts in the background; false or absent omits the sentence. */
  readonly background?: boolean;
}

/** One agents-index entry: the agent file's description and, when it declares any, its tools. */
export interface AgentsIndexEntry {
  readonly qualifiedName: string;
  readonly description: string;
  /** The agent file's `tools` as written; `[]` renders `(tools: none)`, absent renders nothing. */
  readonly tools?: readonly string[];
}

export interface SubagentInstructionsInput {
  readonly agent: Pick<AgentResource, "prompt">;
  readonly mode: "full" | "guarded";
  readonly rulesIndex: readonly RulesIndexEntry[];
  /** The rendered memory index; placed before the agent's own prompt when present and non-empty. */
  readonly memoryIndex?: string;
  /**
   * The tools this run maps for the agent, from `mapSubagentTools`. Absent means the
   * agent declared no `tools:` and the session inherits; `[]` means only the always-on
   * tools. Present renders the tools section before the agent's own prompt.
   */
  readonly allowedTools?: readonly string[];
}

/** One line per agent: its description, then the tools it declares, when it declares any. */
function agentEntryLine(entry: AgentsIndexEntry): string {
  const head = `- ${entry.qualifiedName}: ${cleanIndexDescription(entry.description)}`;
  if (entry.tools === undefined) return head;
  return `${head} (tools: ${entry.tools.length === 0 ? "none" : entry.tools.join(", ")})`;
}

/** Advertise available agents without inlining their prompts. */
export function buildAgentsInstructions(
  entries: readonly AgentsIndexEntry[],
  options: AgentsInstructionsOptions = {},
): string {
  const lines = [
    `When a task suits one of these agents, call nax-agents__run with the agent name and a self-contained task.${options.background === true ? ` ${BACKGROUND_DEFAULT_SENTENCE}` : ""}`,
    "Pass model to run an agent on another model: provider/model for the nax native agent (openai-codex/gpt-6-luna is native), acp:<agent> for an installed ACP agent.",
    `When no agent fits, omit agent (or pass agent general): the task runs on the built-in general agent with your tools, on your model unless you pass model. ${EXPLORE_SENTENCE}`,
  ];
  for (const entry of entries.slice(0, MAX_AGENTS_INDEX_ENTRIES)) {
    lines.push(agentEntryLine(entry));
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

const SCRATCHPAD_TOOLS_SUFFIX = "plus the always-on scratchpad tools";
const ONLY_SCRATCHPAD_TOOLS = "only the always-on scratchpad tools";
const HAND_OFF_TO_CALLER =
  "The agent that called you has its own tools; a step your tools cannot do goes in your final answer, with what is left and the path of any draft, rather than in a question to the person.";

/**
 * The tools section: the tools this run maps for the agent, then what to do with a
 * step they cannot cover. Entries are rendered exactly as mapped, so a pattern such
 * as `nax-skills__*` reads as the pattern the session admits.
 *
 * It states what the agent has and where an incomplete step is reported. The calling
 * agent can finish what this one cannot, so asking the person is the wrong channel.
 */
function subagentToolsSection(allowedTools: readonly string[]): string {
  const tools =
    allowedTools.length === 0 ? ONLY_SCRATCHPAD_TOOLS : `${allowedTools.join(", ")}, ${SCRATCHPAD_TOOLS_SUFFIX}`;
  return [`Your tools in this run: ${tools}.`, HAND_OFF_TO_CALLER].join("\n");
}

/** System instructions of a nested agent session: permissions, rules index, memory index, then the agent's own prompt. */
export function buildSubagentInstructions(input: SubagentInstructionsInput): string {
  const sections = [chatPermissionParagraph(input.mode)];
  const rules = buildRulesIndexSection({ entries: input.rulesIndex, shownAutomatically: true });
  if (rules) sections.push(rules);
  const memory = memorySectionOf(input.memoryIndex);
  if (memory !== undefined) sections.push(memory);
  if (input.allowedTools !== undefined) sections.push(subagentToolsSection(input.allowedTools));
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

/**
 * The whole prompt of the built-in explore agent: a read-only searcher, so it is told to
 * find and read code and report where it is, and to change nothing.
 */
export function buildExploreAgentPrompt(): string {
  return [
    "You are a read-only code search subagent. Find and read the code the task asks about with Read, Glob, Grep and Git, and report what you found as file paths and line numbers.",
    "Change nothing: you have no tool that writes, and the agent that called you reads only your last message.",
  ].join("\n");
}
