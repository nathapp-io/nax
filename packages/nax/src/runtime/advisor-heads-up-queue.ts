/**
 * A1: run-scoped queue for flagged advisor decisions made where no notification
 * channel exists (the fix cycle). The only drain site, `decideStageAction`, was
 * deleted with the post-run inspection layer (US-003); the queue and its `drain`
 * accessor are retained for wave B2b-2. No imports, so the runtime can own it
 * without reaching into `@/advisor`.
 */
export class AdvisorHeadsUpQueue {
  private readonly byStory = new Map<string, string[]>();

  push(storyId: string, text: string): void {
    this.byStory.set(storyId, [...(this.byStory.get(storyId) ?? []), text]);
  }

  drain(storyId: string): string[] {
    const items = this.byStory.get(storyId) ?? [];
    this.byStory.delete(storyId);
    return items;
  }
}
