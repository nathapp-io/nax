/** A5 workflow mode: the story brief and every implementer-session prompt (spec §6). */

import { buildProjectContextSection } from "./project-context-builder";
import { buildRulesIndexSection, type RulesIndexEntry } from "./rules-index-builder";

export interface WorkflowPromptFinding {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly issue: string;
  readonly file?: string;
  readonly line?: number;
  readonly acId?: string;
  readonly suggestion?: string;
  readonly observed?: string;
}

export interface WorkflowBriefInput {
  readonly storyId: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly contextFiles: readonly string[];
  readonly expectedFiles: readonly string[];
  readonly specPath?: string;
  readonly specExcerpts: readonly string[];
  readonly storyContext?: string;
  readonly featureContext?: string;
  /**
   * US-003: the repository's rules as an index. Omitted (and empty) under
   * `delivery: "push"`, where the v2 orchestrator carries the bodies instead.
   */
  readonly rulesIndex?: { readonly entries: readonly RulesIndexEntry[]; readonly shownAutomatically: boolean };
  /**
   * US-007: `context.projectContext.file`, verbatim. Rendered after
   * "## Feature context" — the feature's own context, then the run's
   * organisation/job context, then the repository's constitution (`constitution`
   * below, under "## Project rules").
   */
  readonly projectContextOverride?: string;
  readonly constitution?: string;
  readonly rulings: readonly string[];
  readonly redBaseDependencies: readonly { readonly storyId: string; readonly reason: string }[];
  readonly reportPath: string;
}

function list(items: readonly string[], empty: string): string {
  return items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : empty;
}

function section(title: string, body: string | undefined): string {
  return body?.trim() ? `## ${title}\n\n${body.trim()}\n` : "";
}

export function renderWorkflowFindings(findings: readonly WorkflowPromptFinding[]): string {
  return findings
    .map((f) => {
      const where = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
      const ac = f.acId ? ` [${f.acId}]` : "";
      const seen = f.observed ? `\n  Observed: ${f.observed}` : "";
      const fix = f.suggestion ? `\n  Suggestion: ${f.suggestion}` : "";
      return `[${f.id}] [${f.severity}/${f.kind}]${ac}${where} ${f.issue}${seen}${fix}`;
    })
    .join("\n");
}

export function buildWorkflowBrief(input: WorkflowBriefInput): string {
  const acs = input.acceptanceCriteria.map((ac, i) => `AC-${i + 1}: ${ac}`).join("\n");
  const redBase =
    input.redBaseDependencies.length > 0
      ? section(
          "Warning",
          `You are building on a red base: ${input.redBaseDependencies
            .map((d) => `${d.storyId} ended with a red gate (${d.reason})`)
            .join("; ")}. Expect failures that are not yours, and say so in your report.`,
        )
      : "";
  return [
    `# Brief: ${input.storyId} — ${input.title}\n`,
    section("Story", input.description),
    section("Acceptance criteria (verbatim)", acs),
    section("Files to read first", list(input.contextFiles, "(none listed)")),
    section("Files the plan expects you to change", list(input.expectedFiles, "(none listed)")),
    section(
      "Feature spec",
      `${input.specPath ? `Path: ${input.specPath}. Read the parts that apply to this story.` : "No spec file was found."}${
        input.specExcerpts.length > 0
          ? `\n\nSections that name ${input.storyId}:\n\n${input.specExcerpts.join("\n\n")}`
          : ""
      }`,
    ),
    section("Rulings in force", list(input.rulings, "")),
    redBase,
    section("Story context", input.storyContext),
    input.rulesIndex ? buildRulesIndexSection(input.rulesIndex) : "",
    section("Feature context", input.featureContext),
    buildProjectContextSection(input.projectContextOverride),
    section("Project rules", input.constitution),
    section("Report", `Write your report to ${input.reportPath}.`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** nax#2479: evidence lives in the report, never as new files in the repository. */
export const WORKFLOW_ARTIFACTS_RULE =
  "The report is the only place for evidence, command output and notes: write it with the Write or Edit tool (shell redirects into it are blocked). Do not create evidence, log or note files anywhere else in the repository; use your scratchpad (.nax/scratchpad/) for throwaway files.";

export const WORKFLOW_REPLY_CONTRACT = `End your reply with exactly one fenced json block:

\`\`\`json
{"status": "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED", "commits": ["<sha>"], "testSummary": "<one line>", "concerns": "<empty unless status is not DONE>"}
\`\`\`

Use NEEDS_CONTEXT when you need information the brief does not give you, and BLOCKED when you cannot proceed. Say what you need in "concerns".`;

/**
 * US-009 (nax#2530): browser e2e cannot launch inside the Bash sandbox, so the declared `e2e`
 * command is the only way in. Rendered only when the project declares that gate — a prompt that
 * names a command the project does not have would send the agent looking for it.
 */
const E2E_IMPLEMENTER_RULE =
  'Browser e2e tests cannot launch inside the Bash sandbox. Run the e2e suite only with `RunCommand {"command":"e2e"}`; nax also runs it as a repository gate once every story is done.';

export function buildWorkflowImplementPrompt(input: {
  storyId: string;
  briefPath: string;
  reportPath: string;
  /** US-009: the project declares a host-side e2e gate, so the prompt says how to reach it. */
  e2eGate?: boolean;
}): string {
  const e2e = input.e2eGate ? `${E2E_IMPLEMENTER_RULE}\n\n` : "";
  return `You are the implementer for story ${input.storyId}. Read the brief first: ${input.briefPath}. It is your requirements.

## How to work
1. TDD for every acceptance criterion: write the test, run it, and capture the failing run before you write the implementation for that criterion; then write the code and capture the passing run. Never stash, revert, move or copy aside implementation files to produce a failing run afterwards. Run focused tests while you iterate, not the whole suite.
2. Commit your work with a conventional commit message. Commit before you reply.
3. Self-review your diff before you reply: correctness, edge cases, and anything the brief asks for that you skipped.
4. Do not dispatch sub-agents, helpers or reviewers. A reviewer checks your work after you reply.

${e2e}## Report
Write ${input.reportPath} with these sections:
- **What was built**
- **TDD evidence**: for each AC, the failing run and the passing run (command and the relevant output lines). If you did not capture the failing run, say so under **Decisions & assumptions**; then evidence that the test exercises the new code path is acceptable. Missing evidence without that note, or a test that asserts nothing, fails review.
- **Files changed**
- **Decisions & assumptions**: every judgment call you made and why.

${WORKFLOW_ARTIFACTS_RULE}

${WORKFLOW_REPLY_CONTRACT}`;
}

/**
 * US-001: the warm restart — the implementer never started, so it gets the one-line
 * reminder rather than the full implement prompt (the session already holds it).
 */
export function buildWorkflowRestartPrompt(input: { storyId: string; briefPath: string; reportPath: string }): string {
  return `You have not started story ${input.storyId}: there are no commits, no changes and no report yet. Read the brief at
${input.briefPath} now and implement it as it says. Write ${input.reportPath}, commit your work, and end your reply with
the json status block.

${WORKFLOW_REPLY_CONTRACT}`;
}

export function buildWorkflowFixPrompt(input: {
  mode: "warm" | "fresh";
  round: number;
  maxRounds: number;
  priorRounds: number;
  findings: readonly WorkflowPromptFinding[];
  briefPath: string;
  reportPath: string;
  uncommittedFiles: readonly string[];
}): string {
  const framing =
    input.mode === "fresh"
      ? `A prior implementer tried ${input.priorRounds} times to close these findings; you own it now. Read the brief (${input.briefPath}) and the report (${input.reportPath}) before you change anything.`
      : "The reviewer found these issues in your work.";
  const uncommitted =
    input.uncommittedFiles.length > 0
      ? `\n\nThese files have uncommitted edits from an interrupted turn. Continue from them, do not discard them:\n${input.uncommittedFiles
          .map((f) => `- ${f}`)
          .join("\n")}`
      : "";
  return `Fix round ${input.round} of ${input.maxRounds}. ${framing}

## Findings
${renderWorkflowFindings(input.findings)}${uncommitted}

## How to work
- Fix every finding above. Re-run the tests that cover what you changed, and add a test where a finding names a missing one (TDD: see it fail first).
- Commit, then append a "Fix round ${input.round}" section to ${input.reportPath}: what you changed for each finding id, the test evidence, and any new Decisions & assumptions.
- ${WORKFLOW_ARTIFACTS_RULE}
- Do not dispatch sub-agents or reviewers.

${WORKFLOW_REPLY_CONTRACT}`;
}

export function buildWorkflowAnswerPrompt(answer: string): string {
  return `Answer to your question:

${answer}

Continue the work with this answer. Commit, update the report, and reply with the same json block as before.`;
}
