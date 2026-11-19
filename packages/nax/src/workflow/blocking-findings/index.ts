/**
 * The shared finding vocabulary: what a review finding needs in order to occur (`trigger`, US-001),
 * which of those classes block readiness (`blockingTriggers`, US-002), and how an authorized
 * per-PR scope ruling narrows or widens that set.
 *
 * A nested barrel (`@/workflow/blocking-findings`), not an export of the `@/workflow` barrel: that
 * barrel imports `@/operations` and `@/config`, so routing through it would close an import cycle
 * from `operations/bot-pr-review-reply.ts` and `config/schemas-bot.ts`.
 *
 * This module has only `import type` imports, so nothing here can join a runtime cycle.
 *
 * `readFindingThreadFacts` and `firstIssueLine` read a finding's own text. A caller holding a raw
 * comment body first removes the bot's visible header and its identity markers — `earlierIssue` in
 * `bot/post-earlier.ts` — because neither is part of what the finding says.
 */
import type { PrComment } from "@/forge";
import type { WorkflowSeverity } from "@/operations";

export const FINDING_TRIGGERS = ["normal", "own-concurrency", "adversarial", "manual"] as const;

export type FindingTrigger = (typeof FINDING_TRIGGERS)[number];

/** Missing or unknown reads as "normal", so an unclassified finding still blocks. */
export function parseFindingTrigger(value: unknown): FindingTrigger {
  return FINDING_TRIGGERS.find((trigger) => trigger === value) ?? "normal";
}

/** The classes that hold readiness by default; the two before this feature blocked by severity alone. */
export const DEFAULT_BLOCKING_TRIGGERS: readonly FindingTrigger[] = ["normal", "own-concurrency"];

/** Generation at which the fix summary starts saying the findings are chasing their own fixes. */
export const DEFAULT_CHAIN_NOTICE_GENERATION = 2;

const BLOCKING_SEVERITIES: readonly WorkflowSeverity[] = ["critical", "important"];
const SEVERITY_LABEL = /^\*\*(critical|important|minor)\*\*/i;
const ISSUE_LABEL = /^\*\*(?:critical|important|minor)\*\*(?: \([^)]*\))?:\s*/i;
const TRIGGER_PREFIX = "Trigger:";
const LINEAGE_PREFIX = "Lineage:";
/** A line opening with one of these is quoting a ruling, not making one. */
const QUOTE_MARKERS = [">", "-", "*"];
const SCOPE_RULING = /^blocking triggers:[ \t]*(.*)$/i;

/** Critical or important AND trigger in the set; an absent trigger reads "normal". */
export function isBlockingFinding(
  finding: { readonly severity: WorkflowSeverity; readonly trigger?: FindingTrigger },
  blocking: readonly FindingTrigger[],
): boolean {
  if (!BLOCKING_SEVERITIES.includes(finding.severity)) return false;
  return blocking.includes(finding.trigger ?? "normal");
}

/** Severity and trigger read back from a bot finding thread body (first comment). */
export function readFindingThreadFacts(body: string): { severity: WorkflowSeverity; trigger: FindingTrigger } {
  return { severity: readSeverity(body), trigger: readTrigger(body) };
}

/** The label a bot finding body leads with; an unlabelled body reads important, as `mergeEarlier` did. */
function readSeverity(body: string): WorkflowSeverity {
  const label = SEVERITY_LABEL.exec(body.trimStart())?.[1]?.toLowerCase();
  return label === "critical" || label === "minor" ? label : "important";
}

/** The class a finding states on its `Trigger:` line; absent or unknown reads normal. */
function readTrigger(body: string): FindingTrigger {
  const line = body.split("\n").find((text) => text.startsWith(TRIGGER_PREFIX));
  if (line === undefined) return "normal";
  return parseFindingTrigger(line.slice(TRIGGER_PREFIX.length).split(" - ")[0]?.trim() ?? "");
}

/** The plain first line of a finding issue: no severity label, no Trigger:/Lineage: lines. */
export function firstIssueLine(issue: string): string {
  const kept = issue.split("\n").filter((line) => !line.startsWith(TRIGGER_PREFIX) && !line.startsWith(LINEAGE_PREFIX));
  const first = kept.find((line) => line.trim().length > 0) ?? "";
  return first.trim().replace(ISSUE_LABEL, "").trim();
}

/** `config.bot` is optional on NaxConfig: absent keys read as the defaults. */
export function configuredBlockingTriggers(config: {
  readonly bot?: { readonly blockingTriggers?: readonly FindingTrigger[] };
}): readonly FindingTrigger[] {
  const configured = config.bot?.blockingTriggers;
  // An empty set from an unvalidated config would silently unblock everything; the schema forbids it.
  return configured === undefined || configured.length === 0 ? DEFAULT_BLOCKING_TRIGGERS : configured;
}

/** `config.bot` is optional on NaxConfig: absent keys read as the defaults. */
export function configuredChainNoticeGeneration(config: {
  readonly bot?: { readonly chainNoticeGeneration?: number };
}): number {
  return config.bot?.chainNoticeGeneration ?? DEFAULT_CHAIN_NOTICE_GENERATION;
}

export interface EffectiveBlockingTriggers {
  readonly triggers: readonly FindingTrigger[];
  readonly source: "config" | { readonly commentId: string; readonly author: string };
  /** The first line of every writer scope comment that stated no usable class. */
  readonly invalid: readonly string[];
}

export interface EffectiveBlockingTriggersInput {
  readonly comments: readonly PrComment[];
  readonly writers: ReadonlySet<string>;
  readonly configured: readonly FindingTrigger[];
}

/** One writer comment's first line: not ruling-shaped, ruling-shaped but unusable, or a valid ruling. */
type ScopeRuling =
  | { readonly kind: "none" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly triggers: readonly FindingTrigger[] };

function isFindingTrigger(value: string): value is FindingTrigger {
  return FINDING_TRIGGERS.some((trigger) => trigger === value);
}

/** A ruling is `blocking triggers: <class>[, <class>...]`; a quoted line is not a ruling. */
function parseScopeRuling(line: string): ScopeRuling {
  const match = SCOPE_RULING.exec(line);
  if (match === null || QUOTE_MARKERS.includes(line.charAt(0))) return { kind: "none" };
  const classes = (match[1] ?? "").split(",").map((text) => text.trim().toLowerCase());
  const triggers = classes.filter((text) => isFindingTrigger(text));
  if (triggers.length === 0 || triggers.length !== classes.length) return { kind: "invalid" };
  return { kind: "valid", triggers };
}

function firstNonEmptyLine(body: string): string {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** Forge timestamps are ISO 8601; fall back to text order when one does not parse. */
function isNewer(candidate: string, current: string): boolean {
  const [next, kept] = [Date.parse(candidate), Date.parse(current)];
  return Number.isNaN(next) || Number.isNaN(kept) ? candidate > current : next > kept;
}

interface Ruling {
  readonly comment: PrComment;
  readonly triggers: readonly FindingTrigger[];
}

/** The effective set for one PR: the newest writer scope-ruling comment, else the configured set. */
export function effectiveBlockingTriggers(input: EffectiveBlockingTriggersInput): EffectiveBlockingTriggers {
  const invalid: string[] = [];
  let newest: Ruling | undefined;
  for (const comment of input.comments) {
    // Only a top-level PR comment can rule; a review body or an inline thread reply cannot.
    if (comment.kind !== "comment" || !input.writers.has(comment.author)) continue;
    const line = firstNonEmptyLine(comment.body);
    const ruling = parseScopeRuling(line);
    if (ruling.kind === "none") continue;
    if (ruling.kind === "invalid") {
      invalid.push(line);
      continue;
    }
    if (newest === undefined || isNewer(comment.createdAt, newest.comment.createdAt)) {
      newest = { comment, triggers: ruling.triggers };
    }
  }
  if (newest === undefined) return { triggers: input.configured, source: "config", invalid };
  return {
    triggers: newest.triggers,
    source: { commentId: newest.comment.id, author: newest.comment.author },
    invalid,
  };
}
