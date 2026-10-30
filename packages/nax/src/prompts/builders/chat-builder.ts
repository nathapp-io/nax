import { buildRulesIndexSection, type RulesIndexEntry } from "./rules-index-builder";

export interface ChatInstructionsInput {
  readonly mode: "full" | "guarded";
  readonly rulesIndex: readonly RulesIndexEntry[];
}

export interface ChatFeatureMessageInput {
  readonly feature: string;
  readonly spec: string;
  /** Raw PRD JSON text, not a parsed object. */
  readonly prd?: string;
  readonly message: string;
}

/** The sentence describing what a permission mode means; no heading. */
export function chatPermissionParagraph(mode: ChatInstructionsInput["mode"]): string {
  return mode === "full"
    ? "In full mode, tools run without asking."
    : "In guarded mode, commands run inside the sandbox under the configured posture; a command that asks to run outside the sandbox, any command while the sandbox is unavailable, a call the configured permission rules mark for asking, and a call to an MCP tool that is not read-only are put to the person before they run.";
}

/** Pure system instructions; repository instructions are loaded separately from AGENTS.md. */
export function buildChatInstructions(input: ChatInstructionsInput): string {
  const sections = [
    "You are an interactive coding agent working in this repository with the person.",
    `## Permission mode\n\n${chatPermissionParagraph(input.mode)}`,
    "## Commands outside the sandbox\n\nSet `unsandboxed: true` with an `unsandboxedReason` only when a command needs the network, the Docker socket, a local port or a device the sandbox blocks.",
  ];
  const rules = buildRulesIndexSection({ entries: input.rulesIndex, shownAutomatically: true });
  if (rules) sections.push(rules);
  return sections.join("\n\n");
}

export interface ChatAcpInstructionsInput {
  /** Display name of the ACP agent, e.g. "Codex". */
  readonly agentLabel: string;
  /** Rendered instructions of the nax tools delivered to the agent. */
  readonly toolInstructions?: string;
}

/**
 * System instructions for an ACP chat brain. An ACP session receives them once
 * and a resume does not resend them, so they never state the permission mode.
 */
export function buildChatAcpInstructions(input: ChatAcpInstructionsInput): string {
  const sections = [
    `You are ${input.agentLabel}, working as the coding agent inside nax chat, an interactive session in this repository with the person.`,
    "Use your own tools and skills for the work itself. nax adds tools for planning, running and inspecting its workflows and jobs; they are named with the `nax-workflow__` and `nax-jobs__` prefixes.",
  ];
  if (input.toolInstructions !== undefined && input.toolInstructions !== "") sections.push(input.toolInstructions);
  return sections.join("\n\n");
}

export interface ChatHandoffInput {
  readonly entries: readonly { readonly speaker: string; readonly text: string }[];
  /** Earlier entries left out; shown only when entries are present. */
  readonly omitted: number;
}

const HANDOFF_CLOSE_TAG = "</conversation-so-far>";
const HANDOFF_ESCAPED_CLOSE_TAG = "<\\/conversation-so-far>";
const HANDOFF_INTRO =
  "These turns happened in this nax chat before this message, while you were not the model answering. Use them as context. Tool calls are listed by name only.";

/**
 * The conversation-so-far block put in front of the first message an ACP agent
 * receives after a brain switch. Empty when there are no entries. An entry's
 * text cannot close the block: its closing tag is written with an escaped slash.
 */
export function buildChatHandoff(input: ChatHandoffInput): string {
  if (input.entries.length === 0) return "";
  const lines = ["<conversation-so-far>", HANDOFF_INTRO];
  if (input.omitted > 0) lines.push(`[${input.omitted} older messages omitted]`);
  const body = input.entries
    .map((entry) => `${entry.speaker}: ${entry.text.replaceAll(HANDOFF_CLOSE_TAG, HANDOFF_ESCAPED_CLOSE_TAG)}`)
    .join("\n\n");
  return `${lines.join("\n")}\n\n${body}\n${HANDOFF_CLOSE_TAG}`;
}

const MIN_FENCE_LENGTH = 3;

/** Longer fences keep Markdown examples in a spec from closing its outer block. */
function fenced(text: string, language: string): string {
  let length = MIN_FENCE_LENGTH;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language}\n${text}\n${fence}`;
}

/** The /feature user turn, preserving supplied text including an empty personal message. */
export function buildChatFeatureMessage(input: ChatFeatureMessageInput): string {
  const sections = [`## Feature ${input.feature}`, fenced(input.spec, "markdown")];
  if (input.prd !== undefined) sections.push(fenced(input.prd, "json"));
  sections.push(input.message);
  return sections.join("\n\n");
}
