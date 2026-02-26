import { WorktreeManager } from "./manager";
import type { UserStory } from "../prd/types";

export interface DispatchResult {
  storyId: string;
  success: boolean;
  worktreePath: string;
  error?: string;
}

export class ParallelDispatcher {
  constructor(
    private worktreeManager: WorktreeManager,
    private runPipeline: (args: { workdir: string; story: UserStory }) => Promise<boolean>
  ) {}

  async dispatch(
    projectRoot: string,
    stories: UserStory[],
    maxConcurrency: number
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    const independentBatches = this.getBatches(stories);

    for (const batch of independentBatches) {
      const batchPromises = batch.map(async (story) => {
        const worktreePath = `${projectRoot}/.nax-wt/${story.id}`;
        try {
          await this.worktreeManager.create(projectRoot, story.id);
          const success = await this.runPipeline({ workdir: worktreePath, story });
          return { storyId: story.id, success, worktreePath };
        } catch (err) {
          return {
            storyId: story.id,
            success: false,
            worktreePath,
            error: err instanceof Error ? err.message : String(err)
          };
        }
      });

      const batchResults = await pLimit(maxConcurrency, batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  private getBatches(stories: UserStory[]): UserStory[][] {
    // TODO: Implement dependency-aware batching
    return [stories];
  }
}

// Helper for concurrency limiting (Simplified p-limit)
async function pLimit<T>(concurrency: number, promises: Promise<T>[]): Promise<T[]> {
  const results: T[] = [];
  const executing: Promise<void>[] = [];
  for (const p of promises) {
    const e = p.then((r) => { results.push(r); executing.splice(executing.indexOf(e), 1); });
    executing.push(e);
    if (executing.length >= concurrency) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
}