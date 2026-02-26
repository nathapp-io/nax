import { WorktreeManager } from "./manager";
import type { Story } from "../prd/types";

export interface DispatchResult {
  storyId: string;
  success: boolean;
  worktreePath: string;
  error?: string;
}

export class ParallelDispatcher {
  constructor(
    private worktreeManager: WorktreeManager,
    private runPipeline: (args: { workdir: string; story: Story }) => Promise<boolean>
  ) {}

  async dispatch (
    projectRoot: string,
    stories: Story[],
    maxConcurrency: number
  ): Promise<DispatchResult[]> {
    const results: DispatchResult[] = [];
    const independentBatches = this.getBatchesstories(stories);

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
            error: err	instanceof Error ? err.message : String(err)
          };
        }
      });

      const batchResults = await p-limit(maxConcurrency, batchPromises);
      results.push(...batchResults);
    }

    return results;
  }

  private getBatchesstories(stories: Story[]): Story[][] {
    // TODO: Implement dependency-aware batching
    return [stories];
  }
}

// Helper for concurrency limiting (Simplified p-limit)
async function p-limit<T>(concurrency: number, promises: Promise<T>[]): Promise<T[]> {
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