/**
 * The fixed instructions the `nax-flow` provider carries into a chat session:
 * when to reach for `nax-flow__send`, what the branch must look like, how to
 * order the features, and that the user is asked twice before anything is billed.
 *
 * Pure fixed text — no config, no file reads, no model calls.
 */
export function buildFlowInstructions(): string {
  return [
    "`nax-flow__send` hands a settled set of feature specs from this chat to koda as a flow; call it only when the user asks you to send specs to koda.",
    "The specs must already be committed on a feature branch with a clean working tree — untracked files included: this tool pushes the branch and never commits or stashes for you.",
    "List the features in dependency order, each with its own spec path; a `dependsOn` entry must name a feature that appears earlier in the list.",
    "The user approves an approval card in this chat that names the repository, branch, commit and cost cap, and then approves the flow again in koda: koda asks for its own approval before anything billed starts.",
    "A denial is final for that call; do not retry with changed arguments unless the user asks, and report the flow's link once koda has created it.",
  ].join("\n");
}
