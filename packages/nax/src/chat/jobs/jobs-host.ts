import { isWorkflowMode, type NaxConfig } from "@/config";
import type { Logger } from "@/logger";
import type { ChatAskController } from "../ask-controller";
import { type ChatChains, createChainController } from "./chain-controller";
import { createJobRunner } from "./job-runner";
import { createJobWriteGuard } from "./job-write-guard";
import { createJobsProvider } from "./jobs-provider";
import { type ChatRunAsks, createRunAsks } from "./run-asks";

interface HostJobsOptions {
  readonly repoRoot: string;
  readonly outputDir: string;
  readonly naxEntry: readonly string[];
  readonly config: NaxConfig;
  readonly asks: ChatAskController;
  readonly sessionId: () => string;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

/** Compose repo-scoped jobs only for the parent chat, never for subagent providers. */
export function createHostJobs(options: HostJobsOptions): {
  jobs: ReturnType<typeof createJobRunner>;
  chains: ChatChains;
  runAsks: ChatRunAsks;
  provider: ReturnType<typeof createJobsProvider>;
  guard: ReturnType<typeof createJobWriteGuard>;
  close: () => void;
  sessionChanged: () => void;
} {
  const jobs = createJobRunner({ repoRoot: options.repoRoot, outputDir: options.outputDir, now: options.now });
  const closing = new AbortController();
  let sessionGeneration = 0;
  const chains = createChainController({
    sessionGeneration: () => sessionGeneration,
    outputDir: options.outputDir,
    closeSignal: closing.signal,
    cwd: options.repoRoot,
    jobs,
    sessionId: options.sessionId,
    now: options.now,
  });
  const runAsks = createRunAsks({ ...options, jobs, chains });
  const approve: ChatAskController["requestHostApproval"] = (card) => options.asks.requestHostApproval(card);
  const provider = createJobsProvider({
    ...options,
    jobs,
    chains,
    runAsks,
    approve,
    maxIterations: isWorkflowMode(options.config) ? undefined : options.config.execution.maxIterations,
    interactionPlugin: options.config.interaction?.plugin ?? "cli",
  });
  const close = (): void => {
    runAsks.dispose();
    closing.abort();
    chains.stop("the chat closed");
  };
  const sessionChanged = (): void => {
    sessionGeneration++;
    chains.stop("chat session changed");
  };
  return {
    jobs,
    chains,
    provider,
    runAsks,
    guard: createJobWriteGuard(jobs, options.repoRoot),
    close,
    sessionChanged,
  };
}
