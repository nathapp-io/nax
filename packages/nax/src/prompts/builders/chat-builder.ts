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

/** Pure system instructions; repository instructions are loaded separately from AGENTS.md. */
export function buildChatInstructions(input: ChatInstructionsInput): string {
  const permission =
    input.mode === "full"
      ? "In full mode, tools run without asking."
      : "In guarded mode, edits, deletes, commits and every shell command are put to the person before they run.";
  const sections = [
    "You are an interactive coding agent working in this repository with the person.",
    `## Permission mode\n\n${permission}`,
    "## Commands outside the sandbox\n\nSet `unsandboxed: true` with an `unsandboxedReason` only when a command needs the network, the Docker socket, a local port or a device the sandbox blocks.",
  ];
  const rules = buildRulesIndexSection({ entries: input.rulesIndex, shownAutomatically: true });
  if (rules) sections.push(rules);
  return sections.join("\n\n");
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
