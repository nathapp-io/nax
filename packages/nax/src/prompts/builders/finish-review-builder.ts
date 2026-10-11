/**
 * A4 finish prompts (spec §4.2, §4.3, §5): the branch-level spec review, the
 * branch review, their JSON retry prompts, and the finish fix prompt.
 * Replaces the markdown contract in `src/finish/review/prompt.ts`.
 */
import type { A3Hint } from "@/finish/a3-hints";
import type { Finding } from "@/finish/types";

const BRANCH_FIELDS = `,
 "title":"<conventional-commit PR title, at most 72 characters>",
 "summary":"<what changed on this branch and why, a few short paragraphs for a reviewer>"`;

function replyShape(extraFields: string): string {
  return `## Reply
Reply with only one JSON object, no prose before or after it:
{"findings":[{"severity":"HIGH|MEDIUM|LOW|CRITICAL","title":"<short>","problem":"<what is wrong>","fix":"<what to change>","file":"<repo-relative path>","line":<number or omit>,"judgment":<true only if it needs a decision, not a code change>,"judgmentReason":"<why, when judgment>"}],
 "covered":["<every repo-relative path you read>"]${extraFields}}
An empty "findings" array means you found nothing. Do not invent findings to fill it.`;
}

const QUALITY_CHECKLIST = `## Clean-code checklist
Report only concrete, objective issues, not style preferences:

- **Test isolation:** mutating \`os.environ\` / globals / singletons / filesystem
  without teardown; cross-test ordering dependence; shared mutable fixtures. A
  test that only passes because another test happens to clean up after it is a
  defect even when the suite is currently green.
- **Dead / redundant code:** assignments with no effect, unreachable branches,
  set-up the constructor already performed, unused locals introduced by the diff;
  logic duplicated from an existing helper the diff could have reused.
- **Resource leaks:** opened files / sockets / handles / subprocesses not closed;
  timers / listeners not cleared.
- **Error handling:** swallowed exceptions, bare catches that hide failures,
  missing validation on a newly-introduced input path.
- **Concurrency:** shared state mutated without synchronisation; \`await\` inside a
  loop that should be batched; a race between a check and the action it guards.
- **Performance:** N+1 queries or network calls in a loop; blocking I/O on a hot
  path; an obviously quadratic scan over a large collection the diff introduces.
- **Accessibility (UI diffs only):** interactive elements without an accessible
  name/label, missing \`alt\`, non-keyboard-reachable controls, form inputs with
  no associated label.
- **Security (only when the diff touches it):** hardcoded secrets, unvalidated
  user input reaching a sink, injection vectors.
- **Type safety:** unsafe casts, \`any\`/\`unknown\` escapes, weakened or widened
  types the diff introduces, or a narrowing the diff drops — anywhere the change
  trades a compile-time guarantee for a runtime risk.
- **Design & maintainability (open-ended — not a closed checklist):** a changed
  function that conflates multiple responsibilities (poor separation of
  concerns); an abstraction the diff introduces that is premature (single caller,
  speculative generality) or leaky (callers must understand its internals to use
  it safely); logic the diff writes inline that an existing helper already
  provides (reinvention, not just literal duplication); control flow so nested or
  convoluted the next reader will misread it; an identifier whose name actively
  misleads about what it holds or does; a comment or docstring the diff now leaves
  stale or contradicting the code it sits on, or a changed public API left without
  the docs a caller needs; an edge case the changed code's *own* logic implies but
  doesn't handle. These are the qualitative "this code isn't good yet" findings —
  judge them, don't skip them because they aren't on the defect list above. Anchor
  each to the changed line and state the concrete cost (what breaks, or who is
  misled, later).`;

/**
 * The pre-A4 quality reviewer's recall procedure (`finish/review/references/`,
 * deleted with the markdown contract in #2449). Every catch-rate case the old
 * reviewer caught and A4 missed traced to these three steps, so they come back
 * with the JSON contract kept as-is: the walk stays private and no WALK section
 * is asked for.
 */
const BRANCH_PROCEDURE = `## Read the unchanged collaborators before judging
Most real defects in a focused diff live on the boundary between the changed code and the
*unchanged* code it calls into, which is not in the diff. List every symbol the changed code
uses but does not define: callees, interface or polymorphic calls (every implementation, not
one), new arguments passed to existing APIs, unchanged consumers of an output whose meaning
changed. Read each definition with Read/Grep before concluding. A failure path matters as much
as the happy path: what state does the store, file or table end in if a step throws halfway?
Treat an untested cross-cutting claim as unverified, not satisfied.

## Walk every changed function before you conclude
Go through every function or method the diff adds or changes, in test files as well as
production ones, and give each a private one-line verdict: earns its place, or a concern. Do
this in your reasoning only; do not put the walk in the reply. A review that pattern-matches a
few obvious smells and stops will under-report.

## Confidence threshold
Report a finding you are at least 60% confident is real, provided it is anchored to a changed
line and names a concrete correctness or maintenance cost. Design problems rarely clear 80%;
let them land as MEDIUM or LOW rather than dropping them. Still leave out pure formatting and
taste with no stated cost. This floor applies to every item in the checklist below.`;

function fileList(files: string[], base: string): string {
  return files.length > 0
    ? files.map((f) => `- ${f}`).join("\n")
    : `(could not list them — read \`git diff ${base}...HEAD\`)`;
}

export interface FinishSpecReviewPromptInput {
  base: string;
  specPath: string;
  prdPath: string;
  changedFiles: string[];
  decisions?: string;
}

export function buildFinishSpecReviewPrompt(input: FinishSpecReviewPromptInput): string {
  return [
    "You are reviewing a finished feature branch against its spec, as a whole. You do not edit anything.",
    `## Inputs\n- Spec: \`${input.specPath}\`\n- PRD (stories and acceptance criteria): \`${input.prdPath}\`\n- Diff: \`git diff ${input.base}...HEAD\``,
    `## Changed files\n${fileList(input.changedFiles, input.base)}`,
    ...(input.decisions ? [`## Decisions already made (do not raise these again)\n${input.decisions}`] : []),
    [
      "## What to look for",
      "- Spec requirements that no story implemented (the PRD may have dropped or split them).",
      "- Constraints that span stories: limits, ordering, atomicity, error behaviour.",
      "- A later story contradicting or undoing an earlier one.",
      "- Code that conflicts with the spec. Mark these `judgment: true` when deciding needs a person or the advisor.",
      "Do not re-check acceptance criteria one by one — each story's review already did. Do not report code style.",
    ].join("\n"),
    replyShape(""),
  ].join("\n\n");
}

export interface FinishBranchReviewPromptInput {
  base: string;
  stories: { id: string; title: string }[];
  changedFiles: string[];
  hints: A3Hint[];
}

function hintLine(h: A3Hint): string {
  const where = h.file ? `${h.file}${h.line ? `:${h.line}` : ""}` : "(no file)";
  return `- ${where} — ${h.message} (skipped: ${h.reason})`;
}

export function buildFinishBranchReviewPrompt(input: FinishBranchReviewPromptInput): string {
  const stories =
    input.stories.length > 0 ? input.stories.map((s) => `- ${s.id}: ${s.title}`).join("\n") : "(none listed)";
  return [
    "You are reviewing a finished feature branch as a whole, across all of its stories. You do not edit anything.",
    `## Inputs\n- Diff: \`git diff ${input.base}...HEAD\`\n\n## Stories\n${stories}`,
    `## Changed files\n${fileList(input.changedFiles, input.base)}`,
    [
      "## What to look for",
      "- New code that nothing in production reaches (not wired in, only called from tests).",
      "- Logic duplicated across stories, or duplicating an existing helper.",
      "- Inconsistent patterns between stories for the same kind of thing.",
    ].join("\n"),
    BRANCH_PROCEDURE,
    QUALITY_CHECKLIST,
    ...(input.hints.length > 0
      ? [
          `## Previously skipped as not worth fixing — re-raise only if the whole branch makes it matter\n${input.hints.map(hintLine).join("\n")}`,
        ]
      : []),
    replyShape(BRANCH_FIELDS),
  ].join("\n\n");
}

export function buildFinishReviewJsonRetry(): string {
  return 'Your reply was not the required JSON object. Re-send it now as only {"findings":[...],"covered":[...]} (plus "title" and "summary" if you were asked for them), with no other text.';
}

export function buildFinishReviewJsonRetryCondensed(): string {
  return 'Your reply was cut off. Re-send a shorter version: keep every finding but shorten "problem" and "fix" to one sentence each, and keep "summary" under 120 words. Only the JSON object.';
}

function numbered(findings: Finding[], offset: number): string {
  return findings
    .map((f, i) => {
      const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      return `[${offset + i + 1}] [${f.severity}] ${f.title}${where}\n  Problem: ${f.problem}\n  Fix: ${f.fix}`;
    })
    .join("\n");
}

const NO_COMMIT = "Do not commit, push, or open PRs — nax commits and pushes your edits itself.";

function buildReviewFixPrompt(findings: Finding[]): string {
  const spec = findings.filter((f) => f.source === "spec");
  const quality = findings.filter((f) => f.source !== "spec");
  return [
    "Resolve the branch review findings below, directly in the repo.",
    NO_COMMIT,
    ...(spec.length > 0 ? [`## Spec findings\n${numbered(spec, 0)}`] : []),
    ...(quality.length > 0 ? [`## Quality findings\n${numbered(quality, spec.length)}`] : []),
    [
      "A finding may be REJECTED rather than fixed — only on evidence: an existing test that deliberately pins",
      "the current behaviour, or a spec statement that requires it. Cite the `file:line`. Fix everything else.",
    ].join("\n"),
    [
      "After fixing, re-run the feature's acceptance tests and the relevant checks.",
      "Then end your reply with one line per finding, numbered as above:",
      "",
      "## DISPOSITIONS",
      "[1] fixed",
      "[2] rejected — evidence: test/unit/foo.test.ts:42",
    ].join("\n"),
  ].join("\n\n");
}

export function buildFinishFixPrompt(
  phase: "acceptance" | "gate" | "review",
  args: { findings?: Finding[]; gateOutput?: string; acceptanceOutput?: string },
): string {
  if (phase === "review") return buildReviewFixPrompt(args.findings ?? []);
  const detail = phase === "gate" ? (args.gateOutput ?? "") : (args.acceptanceOutput ?? "");
  return [
    `Fix the failing ${phase === "gate" ? "repo checks" : "acceptance tests"} below, directly in the repo.`,
    NO_COMMIT,
    `Output:\n${detail}`,
    "After fixing, re-run them; stop when they pass.",
  ].join("\n\n");
}
