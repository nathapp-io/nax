/**
 * Patch prompt builder for the verifier-pick selector patch step.
 *
 * Generates a prompt that asks the agent to reconcile acceptance criteria
 * from a runner-up proposal into the winner proposal.
 */

export class PatchPromptBuilder {
  build(winnerOutput: string, deltas: string[]): string {
    // TODO: Implement patch prompt generation
    // Build a prompt that:
    // 1. Presents the winner proposal output
    // 2. Lists distinct ACs from runner-up
    // 3. Asks agent to patch winner with insights from runner-up
    // 4. Limits to maxDeltas distinct criteria

    const deltaList = deltas.map((d, i) => `${i + 1}. ${d}`).join("\n");

    return `You are enhancing a proposal by incorporating insights from a runner-up variant.

## Original Proposal
${winnerOutput}

## Runner-Up Distinct Criteria (limit to ${deltas.length})
${deltaList}

Please enhance the original proposal to address these runner-up criteria while maintaining the strengths of the original.`;
  }
}
