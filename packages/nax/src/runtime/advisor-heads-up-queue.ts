/**
 * A1: run-scoped queue for flagged advisor decisions made where no notification
 * channel exists (the fix cycle). `decideStageAction` drains a story's entries
 * through `sendPostRunNotification` at stage end (spec §12.4). No imports, so the
 * runtime can own it without reaching into `@/advisor`.
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
