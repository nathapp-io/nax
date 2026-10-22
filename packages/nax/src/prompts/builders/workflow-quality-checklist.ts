/**
 * The shared code-quality checklist both workflow reviewers judge a change against
 * (SPEC-workflow-review-depth § Approach 1, nax#2622).
 *
 * Text, not a builder: the story review and the branch review embed it verbatim, so one
 * edit here changes the remit of both and the two can never drift apart. The nine
 * classes are what the story review had no words for — a reviewer asked only for
 * "correctness, error handling, edge cases" cannot name a lost update or a fake id
 * generator on a production path.
 */
export const WORKFLOW_QUALITY_CHECKLIST = `## Code-quality checklist
Judge the changed code against each class. Report only what you can quote from a file.
- Concurrency and atomicity: a check and the write it guards in separate statements or transactions; two writers racing on one row, slot or counter; shared mutable state without synchronisation.
- State loss: a write that replaces a whole record, map entry or file that other code also fills, so the fields this write did not set are dropped; a reset, retry or migration that discards state still in use.
- Data-store semantics: the collation or case-sensitivity of identity and unique columns; uniqueness enforced only in code, not by the store; transaction boundaries; column types and widths against the values written.
- Production wiring: an in-memory, fake or test stand-in on a production path where the project provides a shared implementation (an id or sequence generator, cache, lock, queue, storage).
- Test isolation: a test that depends on state another test created; ordering dependence; shared mutable fixtures; globals, environment or files not restored.
- Input safety: untrusted keys used for object lookup (inherited keys such as __proto__ or constructor); unbounded lengths or sizes reaching storage; unvalidated input reaching a query, path or command.
- Performance: a database or network call per item inside a loop on a batch path; serial awaits that could be one batched call.
- Error handling: a swallowed failure; a result or exit code never checked; a default substituted on error so the caller cannot tell empty from broken.
- Reachability: a list with no way past its first page; a state a user or caller cannot reach or leave.
A state loss a caller can reach is a critical or important finding, never minor; if you cannot quote it, put it in cannotVerify.`;

/**
 * How both reviewers must walk the diff before giving the `quality` verdict: a checklist
 * applied to nothing is a checklist applied to nothing in particular.
 */
export const WORKFLOW_ENUMERATION_INSTRUCTION =
  "Before you give the quality verdict, walk every function or method the diff adds or changes and judge it against the checklist.";

/** Shared design remit for branch and bot reviews; edited designs are not settled authority. */
export const WORKFLOW_DESIGN_DECISIONS_ITEM =
  "Design decisions: if the repository has ADRs or architecture docs (for example docs/adr/ or docs/architecture/), check the change against the decisions that touch it. If the PR edits an ADR or design doc, review that edit as a design change and do not judge the rest of the PR against the edited text. If there are no decisions to apply, skip this item.";
