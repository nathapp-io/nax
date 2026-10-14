/** A5 workflow mode: the whole-branch review, its scoped re-review, and the one branch fix (spec §7 steps 2-4). */
import {
  renderWorkflowFindings,
  WORKFLOW_ARTIFACTS_RULE,
  WORKFLOW_REPLY_CONTRACT,
  type WorkflowPromptFinding,
} from "./workflow-implementer-builder";

export interface BranchReviewPromptInput {
  readonly specPath?: string;
  readonly prdPath: string;
  readonly preflightPath?: string;
  readonly packagePath: string;
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

const REVIEW_JSON =
  '{"spec": "pass|fail", "quality": "approved|changes", "findings": [{"severity": "critical|important|minor", "kind": "spec|quality", "file": "path", "line": 0, "acId": "AC-3", "issue": "what is wrong", "suggestion": "how to fix"}], "cannotVerify": ["..."], "minorTriage": [{"id": "M1", "decision": "fix-now|leave"}]}';

export function buildWorkflowBranchReviewPrompt(input: BranchReviewPromptInput): string {
  const preflight = input.preflightPath ? `\n- the pre-flight rulings: ${input.preflightPath}` : "";
  const gates = input.gateFindings.length > 0 ? renderWorkflowFindings(input.gateFindings) : NONE;
  return `You are reviewing a whole feature branch. Every story was implemented and reviewed on its own already. Read:
- the feature spec: ${input.specPath ?? "(no spec file found)"}
- the PRD (stories and acceptance criteria): ${input.prdPath}${preflight}
- the branch review package (commits, --stat, full diff with context): ${input.packagePath}. When the diff is truncated, the package ends with "Files not shown in the diff": read those yourself, schema, migration and shared-contract files first.

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
Do not re-review each story line by line; the story reviews did that, each from its own diff, so a contract that spans two stories is yours to check.

Severity: "critical" (wrong or unsafe behaviour), "important" (must fix before the PR), "minor" (worth noting, not blocking). ${CANNOT_VERIFY_RULE}

Reply with only this JSON object:
${REVIEW_JSON}`;
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
