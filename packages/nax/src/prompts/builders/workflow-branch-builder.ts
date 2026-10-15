/** A5 workflow mode: the whole-branch review, its scoped re-review, and the one branch fix (spec §7 steps 2-4). */
import {
  renderWorkflowFindings,
  WORKFLOW_ARTIFACTS_RULE,
  WORKFLOW_REPLY_CONTRACT,
  type WorkflowPromptFinding,
} from "./workflow-implementer-builder";
import { WORKFLOW_ENUMERATION_INSTRUCTION, WORKFLOW_QUALITY_CHECKLIST } from "./workflow-quality-checklist";

export interface BranchReviewPromptInput {
  readonly specPath?: string;
  readonly prdPath: string;
  readonly preflightPath?: string;
  readonly packagePath: string;
  /** `<seed>..HEAD`: the commit range every changed file is read through (US-001). */
  readonly range: string;
  readonly stories: readonly { readonly id: string; readonly state: string; readonly note?: string }[];
  readonly minors: readonly { readonly id: string; readonly storyId: string; readonly text: string }[];
  readonly parked: readonly { readonly storyId: string; readonly text: string }[];
  readonly cannotVerify: readonly { readonly storyId: string; readonly text: string }[];
  readonly gateFindings: readonly WorkflowPromptFinding[];
  /**
   * US-006 (nax#2527): the repo gates nax ran before this review. Structurally the workflow
   * module's `RepoGateSummary`, declared inline so this builder imports nothing from `@/workflow`.
   */
  readonly repoGates?: { readonly ran: readonly string[]; readonly failing: readonly string[] };
}

const NONE = "(none)";

function bullets(lines: readonly string[]): string {
  return lines.length > 0 ? lines.map((l) => `- ${l}`).join("\n") : NONE;
}

const listOr = (items: readonly string[], empty: string): string => (items.length > 0 ? items.join(", ") : empty);

/** What nax itself checked on the branch before this review, and what it runs after it. */
function naxCheckedBlock(repoGates: BranchReviewPromptInput["repoGates"]): string {
  const ran = listOr(repoGates?.ran ?? [], "not run");
  const failing = listOr(repoGates?.failing ?? [], "none");
  return `## What nax already checked
Repository gates before this review: ${ran}; failing: ${failing}.
nax runs them again after the branch fix. Do not list any of these as something you could not verify.`;
}

/** The narrowed cannotVerify rule and the evidence rule behind an unavailability claim (US-006, nax#2531). */
const CANNOT_VERIFY_RULE = `Put in "cannotVerify" only what neither nax's gates nor a scoped command can check, such as behaviour that needs a live external service.
Say a tool or service is unavailable only together with the command you ran and the error it returned; otherwise say what you did not try.`;

function storyLines(input: BranchReviewPromptInput): string {
  return bullets(input.stories.map((s) => `${s.id}: ${s.state}${s.note ? ` (${s.note})` : ""}`));
}

/**
 * The branch package's "How to read the diff" section: the package holds no diff body, so the
 * reviewer pulls each changed file itself (SPEC-workflow-review-depth § Approach 2). `writeBranchReviewPackage`
 * appends the same text to the package it writes, so prompt and package give one instruction.
 */
export function buildBranchPackageReadingNote(range: string): string {
  return `## How to read the diff
No diff is inlined. For each changed file run \`git diff ${range} -- <path>\`, or Read a file the branch added. Start with production source, then migrations and schema, then tests.`;
}

const REVIEW_JSON =
  '{"spec": "pass|fail", "quality": "approved|changes", "inspectedFiles": ["path"], "findings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "acId": "AC-3", "issue": "what is wrong", "observed": "verbatim excerpt", "suggestion": "how to fix"}], "cannotVerify": ["..."], "minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]}';

export function buildWorkflowBranchReviewPrompt(input: BranchReviewPromptInput): string {
  const preflight = input.preflightPath ? `\n- the pre-flight rulings: ${input.preflightPath}` : "";
  const gates = input.gateFindings.length > 0 ? renderWorkflowFindings(input.gateFindings) : NONE;
  return `You are reviewing a whole feature branch. Every story was implemented and reviewed on its own already. Read:
- the feature spec: ${input.specPath ?? "(no spec file found)"}
- the PRD (stories and acceptance criteria): ${input.prdPath}${preflight}
- the branch review package (commits, --stat, changed files; no diff is inlined): ${input.packagePath}

${buildBranchPackageReadingNote(input.range)}

## Stories
${storyLines(input)}

## Repo gate failures
${gates}

## Parked rulings from the story loops
${bullets(input.parked.map((p) => `${p.storyId}: ${p.text}`))}

## What the story reviewers could not verify
${bullets(input.cannotVerify.map((c) => `${c.storyId}: ${c.text}`))}

## Deferred minor findings (triage each one)
${input.minors.length > 0 ? input.minors.map((m) => `[${m.id}] ${m.storyId}: ${m.text}`).join("\n") : NONE}

${naxCheckedBlock(input.repoGates)}

## Your remit
- Cross-story integration and contracts: do the stories fit together, do callers and callees agree, is shared state consistent?
- Reachability: is every new piece wired in and reachable from where the spec says it is used?
- Consistency and duplication across stories.
- Storage against contracts: for every field one story persists and another story reads, writes or validates, the column type and width (as the migration declares it, not only the schema) must hold every value the DTOs, acceptance criteria and API contracts accept.
- Triage each deferred minor as "fix-now" (cheap and worth doing before the PR) or "leave".
Judge every changed file you read against the checklist below, as well as against the cross-story contracts.

${WORKFLOW_QUALITY_CHECKLIST}

${WORKFLOW_ENUMERATION_INSTRUCTION}

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before the PR), "minor" (worth noting, not blocking). Put the most severe findings first. A critical or important finding about what the code does carries "observed": a verbatim excerpt from the file that proves it. ${CANNOT_VERIFY_RULE}

List in inspectedFiles every file you read or diffed.

Reply with only this JSON object:
${REVIEW_JSON}`;
}

/**
 * The coverage retry (US-003, nax#2532): the reviewer replied with a parseable verdict that does not
 * cover every changed file. It is re-prompted in the same session with the paths it missed, the
 * command to read each one, and the instruction to list everything it has read in this session —
 * the first reply's `inspectedFiles` named only the files it opened after the retry prompt, so the
 * whole list has to be sent again, not just the additions.
 */
export function buildWorkflowBranchCoverageRetry(range: string, missing: readonly string[]): string {
  return `Your reply parsed, but its inspectedFiles does not cover every changed file. Read each of these with \`git diff ${range} -- <path>\` (or Read it, if the branch added it), and review it:
${missing.map((path) => `- ${path}`).join("\n")}

List in inspectedFiles every file you have read or diffed in this session, not only the new ones.
Re-send the whole JSON object: the same findings, plus anything the files above turned up.`;
}

export function buildWorkflowBranchReReviewPrompt(input: {
  specPath?: string;
  reportPath: string;
  packagePath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  const spec = input.specPath ? ` the spec (${input.specPath}),` : "";
  return `You are checking the one branch fix. Read${spec} the feature report (${input.reportPath}, see its "Branch fix" section) and the fix package (${input.packagePath}). The package holds only the fix diff.

## Findings the fix had to address
${renderWorkflowFindings(input.findings)}

For each finding id, answer ADDRESSED, PARTIAL or NOT_ADDRESSED. PARTIAL means the fix resolved part of the finding and a smaller problem remains: describe only what remains in "residual". Never list a residual again in "newFindings". Then list new problems introduced only in this fix diff. Do not re-review the rest of the branch.

Reply with only this JSON object:
{"findings": [{"id": "B1", "verdict": "ADDRESSED|PARTIAL|NOT_ADDRESSED", "note": "one sentence", "residual": {"issue": "...", "suggestion": "...", "file": "path", "line": 0}}], "newFindings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "issue": "...", "suggestion": "..."}]}`;
}

export function buildWorkflowBranchFixPrompt(input: {
  specPath?: string;
  prdPath: string;
  reportPath: string;
  findings: readonly WorkflowPromptFinding[];
}): string {
  const spec = input.specPath ? `the spec (${input.specPath}) and ` : "";
  return `You are fixing a feature branch after its whole-branch review. This is the only fix pass: there is no second one. Read ${spec}the PRD (${input.prdPath}) for what the feature must do.

## Findings to fix
${renderWorkflowFindings(input.findings)}

## How to work
- Fix every finding above. Findings marked minor are cheap cleanups the reviewer chose to fix now.
- For a red repo gate, make that gate green. For a story that ended with a red gate, make its gates green.
- Re-run the tests that cover what you changed, and add a test where a finding names a missing one (TDD: see it fail first).
- Commit, then append a "Branch fix" section to ${input.reportPath}: what you changed for each finding id, the test evidence, and any Decisions & assumptions.
- ${WORKFLOW_ARTIFACTS_RULE}
- Do not dispatch sub-agents or reviewers.

${WORKFLOW_REPLY_CONTRACT}`;
}
