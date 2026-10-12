/**
 * The finish PR title and body: a pure deterministic builder over
 * `FinishPrContext`.
 *
 * Pure on purpose. Every fact in a finish body — gate results, story counts,
 * diffstat, review rounds — is a string join over artifacts, which is what
 * keeps a finish PR greppable in history. The only model-authored fields
 * (`narrative`, `title`; both come from the branch review) arrive already resolved, each with a deterministic
 * fallback, so the body never waits on a reviewer.
 *
 * Ported from `flows/nax-finish/steps/pr-body.ts`; the rendering is settled
 * behaviour (nax#1477, nax#1504, nax#1507) and must not drift.
 */

import type { AdviceDecision } from "@/advisor";
import { describeTarget } from "@/advisor";
import type { BodySection } from "@/forge";
import { mergeTemplate } from "@/forge";
import type { LedgerEntry, LedgerState } from "../ledger";
import { stopReason } from "../resolve";
import type { Finding, FindingDisposition, FinishRound, GateFact, HandoffRecord } from "../types";
import type { FinishPrContext, FinishPrStory } from "./context";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** Six hex + one — the abbreviated form used everywhere in PR bodies and logs. */
const SHORT_SHA_LEN = 7;

/**
 * The PR title: the branch reviewer's conventional-commit subject when it
 * produced one, else `feat: <feature>`.
 *
 * That fallback is what this returned unconditionally, and is still what
 * `buildTitle` in `src/plugins/builtin/auto-pr/pr-body.ts` opens with — so a
 * finish run whose branch review produced no title still
 * reads identically to an auto-PR-opened one in a list view. The two diverge
 * only once there is something better to say: `feat: schema-drift-gate` names
 * the run, not the change.
 */
export function buildFinishTitle(ctx: FinishPrContext): string {
  return ctx.title;
}

/**
 * Escape a string for safe inclusion in a single markdown table cell.
 *
 * Mirrors `escapeTableCell` in `src/plugins/builtin/auto-pr/pr-body.ts`,
 * trimmed to the cases the finish body actually needs: pipes (which break
 * the column boundary) and newlines (which create new rows). Backslashes are
 * escaped first so the pipe escape survives a literal backslash in a title.
 */
function escapeTableCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ");
}

/** A string for inline markdown outside a table (reviewer- or user-sourced): no code spans, no tags, one line. */
function escapeInline(value: string): string {
  return value.replace(/`/g, "'").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " ");
}

function formatDuration(durationMs: number): string {
  // `Math.max(0, NaN)` returns NaN, and `Math.floor(Infinity / 1000)` returns
  // Infinity — both would render as `"NaNm NaNs"` / `"Infinitym Infinitys"`.
  // A non-finite duration is a corrupted artifact (status.json is hand-editable),
  // so fall back to zero rather than let it leak into the PR body verbatim.
  if (!Number.isFinite(durationMs)) return "0m 00s";
  const clampedMs = Math.max(0, Math.round(durationMs));
  const totalSeconds = Math.floor(clampedMs / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function buildStoriesSection(stories: FinishPrStory[]): string {
  const lines: string[] = [];
  lines.push("| Story | Title | ACs |");
  lines.push("|-------|-------|-----|");
  for (const story of stories) {
    lines.push(`| ${escapeTableCell(story.id)} | ${escapeTableCell(story.title)} | ${story.acCount} |`);
  }
  return lines.join("\n");
}

/**
 * Takes the whole context rather than the five fields it reads: the section
 * grew past the three-positional-parameter cap in the coding standards, and
 * every field it wants is already on `FinishPrContext`.
 */
function buildVerificationSection(ctx: FinishPrContext): string | null {
  const { acceptance, regression, gatesRan, diffstat, artifactSummary } = ctx;
  const lines: string[] = [];
  if (acceptance !== undefined) lines.push(`- Acceptance: ${acceptance}`);
  if (regression !== undefined) lines.push(`- Regression: ${regression}`);
  if (gatesRan.length > 0) lines.push(`- Gates: ${gatesRan.join(", ")}`);
  if (diffstat !== undefined && diffstat.length > 0) lines.push(`- Diffstat:\n\n\`\`\`\n${diffstat}\n\`\`\``);
  // Stated even though the files are excluded above: a reviewer who diffs the
  // branch themselves sees more than the diffstat quotes, and an unexplained
  // mismatch reads as a stale body.
  if (artifactSummary !== undefined && artifactSummary.length > 0) {
    lines.push(`- Excluded from diffstat — nax run artifacts: ${artifactSummary}`);
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

function buildRoundHeading(round: FinishRound): string {
  const base = `### ${round.phase} attempt ${round.attempt}`;
  if (!round.committed || !round.sha) return base;
  const short = round.sha.slice(0, SHORT_SHA_LEN);
  return `${base} (${short})`;
}

/**
 * What an empty finding list means, in the reader's terms.
 *
 * Four different things used to render identically as "_no findings_", which a
 * human reads as "a reviewer looked at this and approved it" (#1507). Only
 * `passed` means that. `no-reviewer` is the one that actively misleads: the
 * gate phase has no reviewer node at all, so its empty list is the absence of a
 * review, not the result of one.
 *
 * `fixed` and the legacy `undefined` both fall through to "_no findings_":
 * rounds written before `outcome` existed carry no field to read, and claiming
 * anything more specific about them would be inventing detail.
 */
const EMPTY_ROUND_NOTE: Record<string, string> = {
  passed: "- _no findings_",
  "no-reviewer": "- _no reviewer for this phase_",
  unparseable: "- _reviewer output could not be parsed_",
  escalated: "- _escalated for human review_",
  "review-skipped": "- _re-review skipped: this fix touched test files only_",
  incomplete: "- _review sent back: required evidence sections missing_",
  advised: "- _advisor ruled on the judged findings; the phase re-reviews_",
  missing: "- _no verdict from this review_",
};

/** A1: one line naming the advisor decisions a round applied, when it carries any. */
function adviceLine(round: FinishRound): string | null {
  if (!round.advice || round.advice.length === 0) return null;
  const ids = round.advice.map((a) => (a.reused ? `${a.decisionId} (reused)` : a.decisionId)).join(", ");
  return `- _advisor decisions: ${ids}_`;
}

function buildRoundBlock(round: FinishRound): string {
  const lines: string[] = [buildRoundHeading(round)];
  const advice = adviceLine(round);
  if (advice) lines.push(advice);
  if (round.findings.length === 0) {
    lines.push(EMPTY_ROUND_NOTE[round.outcome ?? ""] ?? "- _no findings_");
  } else {
    if (round.outcome === "incomplete") {
      lines.push("- _not acted on — the review was sent back for missing evidence sections_");
    }
    for (const [i, finding] of round.findings.entries()) {
      const d = round.dispositions?.find((x) => x.index === i + 1);
      lines.push(d?.disposition === "rejected" ? renderRejected(finding, d) : renderFinding(finding));
    }
  }
  return lines.join("\n");
}

const ADVISOR_TEXT_CAP = 300;

/** Free text from the advisor goes into a PR body: one line, no HTML tags, capped. */
function flat(text: string): string {
  const one = text
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > ADVISOR_TEXT_CAP ? `${one.slice(0, ADVISOR_TEXT_CAP)}…` : one;
}

/** A1: flagged decisions first, then the rest, then every supersede as an amendment to apply. Null when none. */
function buildAdvisorSection(decisions: AdviceDecision[] | undefined): string | null {
  if (!decisions || decisions.length === 0) return null;
  const line = (d: AdviceDecision): string =>
    `- **${flat(d.id)}**${d.needsHumanConfirm ? " (needs confirmation)" : ""} ${flat(d.storyId ?? "feature")} · ${d.action.type} — ${flat(d.rationale)}`;
  const ordered = [...decisions.filter((d) => d.needsHumanConfirm), ...decisions.filter((d) => !d.needsHumanConfirm)];
  const amendments = decisions.flatMap((d) =>
    d.action.type === "supersede"
      ? [`- ${flat(describeTarget(d.action.target))}: ${flat(d.action.newText)} (${flat(d.id)})`]
      : [],
  );
  const parts = [ordered.map(line).join("\n")];
  if (amendments.length > 0) parts.push(`### Spec amendments to apply\n${amendments.join("\n")}`);
  return parts.join("\n\n");
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function buildCoverageLine(coverage: FinishPrContext["coverage"]): string | null {
  if (!coverage) return null;
  return `- Coverage: spec ${percent(coverage.spec)}, quality ${percent(coverage.quality)}`;
}

function buildRoundsSection(ctx: FinishPrContext): string | null {
  const coverage = buildCoverageLine(ctx.coverage);
  if (ctx.rounds.length === 0) return coverage;
  const blocks = ctx.rounds.map(buildRoundBlock).join("\n\n");
  return coverage ? `${coverage}\n\n${blocks}` : blocks;
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function bySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function renderOpenFinding(finding: Finding): string {
  const where = finding.file ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})` : "";
  return `${renderFinding(finding)}${where}`;
}

const EXCERPT_CAP = 200;

/** One red gate: the name and, when the gate left one, a one-line excerpt. */
function renderRedGate(gate: GateFact): string {
  const excerpt = gate.excerpt ? ` — \`${flat(gate.excerpt).slice(0, EXCERPT_CAP)}\`` : "";
  return `- Gate \`${gate.name}\` is red${excerpt}`;
}

const STATE_ORDER: Record<LedgerState, number> = {
  open: 0,
  rejected: 1,
  "set-aside": 2,
  unresolved: 3,
  "fixed-unreviewed": 4,
  accepted: 5,
  "fixed-reviewed": 6,
  waived: 7,
  superseded: 8,
};
const RESOLVED: ReadonlySet<LedgerState> = new Set(["fixed-reviewed", "waived", "superseded"]);
const TABLE_HEAD = "| Severity | Finding | File | State | Ref |\n|---|---|---|---|---|";

function refCell(e: LedgerEntry): string {
  if (!e.ref) return "";
  const isSha = e.state === "fixed-unreviewed" || e.state === "fixed-reviewed";
  return isSha ? `\`${escapeInline(e.ref.slice(0, SHORT_SHA_LEN))}\`` : escapeTableCell(e.ref);
}

function ledgerRow(e: LedgerEntry): string {
  const loc = e.finding.file ? `${e.finding.file}${e.finding.line !== undefined ? `:${e.finding.line}` : ""}` : "";
  return `| ${e.finding.severity} | ${escapeTableCell(e.finding.title)} | ${escapeTableCell(loc)} | ${e.state} | ${refCell(e)} |`;
}

function sortLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity],
  );
}

/** One table of the live entries, then the resolved ones folded away. Null on an empty ledger. */
function buildFindingsTable(ledger: LedgerEntry[]): string | null {
  if (ledger.length === 0) return null;
  const live = sortLedger(ledger.filter((e) => !RESOLVED.has(e.state)));
  const done = sortLedger(ledger.filter((e) => RESOLVED.has(e.state)));
  const table = live.length > 0 ? `${TABLE_HEAD}\n${live.map(ledgerRow).join("\n")}` : "";
  const folded =
    done.length > 0
      ? `<details><summary>${done.length} resolved</summary>\n\n${TABLE_HEAD}\n${done.map(ledgerRow).join("\n")}\n\n</details>`
      : "";
  return [table, folded].filter(Boolean).join("\n\n");
}

function handoffState(h: HandoffRecord): string {
  if (h.consumed) return "re-applied and committed";
  if (h.reapplied === false) return "set aside, not re-applied";
  return h.limit === "error" ? "crashed, not re-applied" : "pending";
}

function handoffTrouble(h: HandoffRecord): string[] {
  const names = (paths: string[]): string => paths.map(escapeInline).join(", ");
  return [
    ...(h.restored ? [] : ["worktree restore failed"]),
    ...(h.untrackedFailed.length > 0 ? [`your files that could not be put back: ${names(h.untrackedFailed)}`] : []),
    ...(h.untrackedMovedAside.length > 0
      ? [`untracked files over the snapshot cap moved into the handoff: ${names(h.untrackedMovedAside)}`]
      : []),
  ];
}

function renderHandoff(h: HandoffRecord): string {
  const dir = escapeInline(h.dir);
  const where = h.patchSaved ? `\`${dir}/changes.patch\`` : "_patch not saved, work lost_";
  const trouble = handoffTrouble(h);
  const head = `- handoff-${h.n} (${h.phase}, ${h.limit}, ${h.findingIds.length} finding(s)): ${where} — ${handoffState(h)}`;
  return trouble.length > 0 ? `${head}; ${trouble.join("; ")}` : head;
}

const block = (heading: string, items: string[]): string[] =>
  items.length > 0 ? [`### ${heading}\n${items.join("\n")}`] : [];

type Unresolved = NonNullable<FinishPrContext["unresolved"]>;

/** What was set aside and where the finish stopped short. */
function buildStopSections(u: Unresolved): string[] {
  return [
    ...block("Set aside", u.handoffs.map(renderHandoff)),
    ...block(
      "Stops",
      u.stops.map((s) => `- ${escapeInline(stopReason([s]) ?? "stopped")}`),
    ),
  ];
}

/**
 * A4: what stands between this PR and a clean ready, or what the advisor
 * accepted on a ready one. Null when there is nothing to say, so a clean
 * ready PR carries no "Unresolved" heading at all.
 */
function buildUnresolvedSection(ctx: FinishPrContext): string | null {
  const u = ctx.unresolved;
  if (!u) return null;
  const table = buildFindingsTable(u.ledger);
  const checks = [
    ...(u.acceptance === "red" || u.acceptance === "unverified" ? [`- Acceptance: ${u.acceptance}`] : []),
    ...(u.gates.some((g) => g.status === "not-run") ? ["- Gates did not run"] : []),
    ...u.gates.filter((g) => g.status === "red").map(renderRedGate),
  ];
  const shas = u.unreviewed.map((sha) => `\`${sha.slice(0, SHORT_SHA_LEN)}\``).join(", ");
  const parts = [
    ...(u.reason ? [`This PR is a draft: ${flat(u.reason)}`] : []),
    ...(table ? [`### Findings\n${table}`] : block("Open findings", bySeverity(u.findings).map(renderOpenFinding))),
    ...block("Verification failures", checks),
    ...block(
      "Missing reviews",
      u.missing.map((lens) => `- The ${lens} review returned no verdict`),
    ),
    ...block(
      "Unreviewed fix commits",
      u.unreviewed.length > 0 ? [`- ${shas} — fixes no full review round has seen`] : [],
    ),
    ...block("Accepted by the advisor", bySeverity(u.accepted).map(renderOpenFinding)),
    ...buildStopSections(u),
  ];
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function renderFinding(finding: Finding): string {
  return `- [${finding.severity}] ${finding.title}`;
}

/**
 * A waived finding, shown as waived.
 *
 * The alternative — dropping it — would make a rejection indistinguishable from
 * a fix in the only artifact a human reads, which is the failure this whole
 * mechanism exists to avoid.
 */
function renderRejected(finding: Finding, d: FindingDisposition): string {
  const evidence = d.evidence ? `\`${d.evidence}\`` : "_no evidence cited_";
  const caveat = d.evidenceMissing ? " — **evidence path not found**" : "";
  return `- [${finding.severity}] ${finding.title} — _rejected_: ${evidence}${caveat}`;
}

/**
 * Body only — the heading is attached by `buildFinishBody`, which drops any
 * section whose body is null. "No text" therefore cannot render a bare
 * `## What changed` heading, the empty-heading case #1477 forbids.
 */
function buildNarrativeSection(narrative: string | undefined): string | null {
  return narrative?.trim() || null;
}

function buildOutOfScopeSection(outOfScope: string[]): string | null {
  if (outOfScope.length === 0) return null;
  return outOfScope.map((item) => `- ${item}`).join("\n");
}

function buildFooter(run: FinishPrContext["run"]): string | null {
  const { storiesPassed, storiesTotal, durationMs } = run;
  if (storiesPassed === undefined && storiesTotal === undefined && durationMs === undefined) return null;
  const counts =
    storiesPassed !== undefined && storiesTotal !== undefined ? `${storiesPassed}/${storiesTotal} stories` : null;
  const timing = durationMs !== undefined ? formatDuration(durationMs) : null;
  const parts = [counts, timing].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/**
 * The nax-authored sections, in canonical order — the order they appear in
 * when the repo has no template, and the order the leftovers are appended in
 * when it has one. `key` is what `mergeTemplate` matches against the repo's
 * headings; the run footer carries an empty heading so it stays unmatchable
 * and last.
 */
function buildBodySections(ctx: FinishPrContext): BodySection[] {
  const candidates: { key: string; heading: string; body: string | null; leading?: boolean }[] = [
    { key: "unresolved", heading: "Unresolved", body: buildUnresolvedSection(ctx), leading: true },
    { key: "narrative", heading: "What changed", body: buildNarrativeSection(ctx.narrative) },
    { key: "stories", heading: "Stories", body: ctx.stories.length > 0 ? buildStoriesSection(ctx.stories) : null },
    { key: "advisor", heading: "Advisor decisions", body: buildAdvisorSection(ctx.advisorDecisions) },
    { key: "rounds", heading: "Review", body: buildRoundsSection(ctx) },
    { key: "verification", heading: "Verification", body: buildVerificationSection(ctx) },
    { key: "outOfScope", heading: "Out of scope", body: buildOutOfScopeSection(ctx.outOfScope) },
    { key: "footer", heading: "", body: buildFooter(ctx.run) },
  ];
  return candidates
    .filter((c): c is { key: string; heading: string; body: string; leading?: boolean } => c.body !== null)
    .map(({ key, heading, body, leading }) => ({ key, heading, body, ...(leading ? { leading } : {}) }));
}

/**
 * Assemble the body, merged into the repo's own PR template when it has one.
 *
 * The template supplies the *shape* (which headings, in what order) and these
 * sections supply the *content* — see `pr-template-merge.ts` for why appending
 * it verbatim, which is what this used to do, shipped a blank form under a
 * filled one (nax#1504).
 */
export function buildFinishBody(ctx: FinishPrContext): string {
  return mergeTemplate(ctx.template, buildBodySections(ctx), {
    mode: ctx.templateMode,
    sectionMap: ctx.templateSectionMap,
  });
}
