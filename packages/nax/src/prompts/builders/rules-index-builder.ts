/**
 * US-003 (SPEC-lazy-rules-delivery) — the rules index prompt text.
 *
 * Workflow mode no longer pushes every rule body into the brief. Instead the
 * brief carries this index: one line per rule, built from rule frontmatter, so
 * the agent knows which rules exist and opens the file it needs. The bodies are
 * delivered on demand by the native rule-delivery handlers (US-005), which is
 * why `shownAutomatically` changes one sentence: a native session is told the
 * text will arrive by itself, an ACP session ("claude", "codex", …) is told to
 * read the rule's file before writing.
 *
 * Prompt text lives here, not in `src/workflow/`, per the Prompt Builder
 * Convention (forbidden-patterns-source.md).
 */
import { canonicalRulePriority, type ResolvedRule, type RuleSource } from "@/context/rules/rule-set";

/** One line of the index. */
export interface RulesIndexEntry {
  readonly ruleId: string;
  readonly displayPath: string;
  readonly source: RuleSource;
  /** `description:` frontmatter, else the first Markdown heading, else the rule id. */
  readonly description: string;
  /** Empty means every file. */
  readonly appliesTo: readonly string[];
  readonly priority: number;
}

const INDEX_HEADING = "## Rules index";
const INDEX_INTRO_AUTOMATIC =
  "Each rule's full text is shown to you the first time you read, write or edit a file it applies to.";
const INDEX_INTRO_MANUAL = "Before you write or edit a file a rule applies to, read that rule's file.";
const ALL_FILES_SCOPE = "all files";

/** Delivery text (US-005): the nudge prefix on Read, the block content on Write/Edit. */
const DELIVERY_INTRO = "Rules that apply to";
/** The listing a rule past the byte cap gets — its id and file, never its body. */
const DELIVERY_LISTED_ONLY = "Also applies (not shown, open the file):";
/** The refuse-once sentence a Write/Edit block ends with, so the retry is safe. */
const DELIVERY_RETRY = "No files were changed. Review these rules and retry the tool call.";

/**
 * An ATX heading (`# Title`, `## Title ##`). Setext headings are not
 * recognised: the canonical rules store uses ATX, and a rule with no ATX
 * heading falls back to its rule id, which is honest rather than guessy.
 */
const ATX_HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m;

function firstHeadingText(content: string): string | undefined {
  const heading = content.match(ATX_HEADING_RE)?.[1]?.trim();
  return heading ? heading : undefined;
}

/** The index line for one rule. */
function toLine(entry: RulesIndexEntry): string {
  const override = entry.source === "override" ? ", override" : "";
  const scope = entry.appliesTo.length > 0 ? entry.appliesTo.join(", ") : ALL_FILES_SCOPE;
  return `- \`${entry.ruleId}\` (${entry.displayPath}${override}): ${entry.description}. Applies to: ${scope}`;
}

/** Priority ascending, then rule id — code-point, never localeCompare (CTX-5). */
function byPriorityThenId(a: RulesIndexEntry, b: RulesIndexEntry): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

/** A resolved rule as one index entry. */
export function toRulesIndexEntry(rule: ResolvedRule): RulesIndexEntry {
  return {
    ruleId: rule.ruleId,
    displayPath: rule.displayPath,
    source: rule.source,
    description: rule.description?.trim() || firstHeadingText(rule.content) || rule.ruleId,
    appliesTo: rule.appliesTo ?? [],
    priority: canonicalRulePriority(rule),
  };
}

/**
 * The "## Rules index" section, or "" when no rule applies.
 *
 * The input order is not significant: the section sorts its own copy, so two
 * runs over the same rule set produce the same brief byte for byte.
 */
export function buildRulesIndexSection(input: {
  readonly entries: readonly RulesIndexEntry[];
  readonly shownAutomatically: boolean;
}): string {
  if (input.entries.length === 0) return "";
  const intro = input.shownAutomatically ? INDEX_INTRO_AUTOMATIC : INDEX_INTRO_MANUAL;
  const lines = [...input.entries].sort(byPriorityThenId).map(toLine);
  return `${INDEX_HEADING}\n\nThis repository's rules. ${intro} Open a rule's file to read it sooner.\n\n${lines.join("\n")}\n`;
}

/**
 * The delivered-rule text (US-005): what a native session is handed when it
 * reads a governed file, or when it tries to write one whose rule it has not
 * seen yet.
 *
 * The bodies arrive verbatim, each under its own `### <ruleId> (<displayPath>)`
 * heading, because a body that has been summarised is a rewrite of the rule.
 * Rules the caller's byte cap kept out are listed by id and file only — enough
 * for the model to open the file, and the listing is what makes a later call
 * deliver them.
 *
 * `mode` decides one sentence and nothing else: a Read is nudged (the file
 * still arrives), a Write/Edit is refused once with the retry sentence the
 * directory-scoped instruction flow already uses.
 */
export function buildRuleDeliveryText(input: {
  readonly path: string;
  readonly delivered: readonly ResolvedRule[];
  readonly listedOnly: readonly ResolvedRule[];
  readonly mode: "read" | "write";
}): string {
  const blocks: string[] = [`${DELIVERY_INTRO} ${input.path}:\n`];
  for (const rule of input.delivered) {
    blocks.push(`### ${rule.ruleId} (${rule.displayPath})\n${rule.content.trimEnd()}\n`);
  }
  for (const rule of input.listedOnly) {
    blocks.push(`${DELIVERY_LISTED_ONLY} ${rule.ruleId} (${rule.displayPath})`);
  }
  if (input.mode === "write") blocks.push(DELIVERY_RETRY);
  return `${blocks.join("\n")}\n`;
}
