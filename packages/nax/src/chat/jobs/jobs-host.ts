import type { ToolProvider } from "@nathapp/nax-agent";
import type { NaxConfig } from "@/config";
import type { Logger } from "@/logger";
import type { ChatAskController } from "../ask-controller";
import type { ChatMode } from "../chat-mode";
import { createFlowProvider, kodaFlowConnection } from "../flow";
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
  /** Read at each approval, never cached: the user can switch mode mid-session. */
  readonly mode: () => ChatMode;
  readonly sessionId: () => string;
  readonly now: () => Date;
  readonly logger: Pick<Logger, "warn">;
}

export const _jobsHostDeps = { createJobsProvider };

/** The jobs provider, then the flow provider when a koda connection exists. */
function hostProviders(options: HostJobsOptions, provider: ToolProvider): readonly ToolProvider[] {
  const connection = kodaFlowConnection(options.config);
  if (connection === undefined) return [provider];
  // The card goes to the controller itself, never to the jobs provider's mode-aware wrapper:
  // pushing a branch and creating a flow in koda is outward-facing, so the user is asked in
  // every chat mode, full included.
  const flow = createFlowProvider({
    repoRoot: options.repoRoot,
    connection,
    approve: (card) => options.asks.requestHostApproval(card),
  });
  return [provider, flow];
}

/** Compose repo-scoped jobs only for the parent chat, never for subagent providers. */
export function createHostJobs(options: HostJobsOptions): {
  jobs: ReturnType<typeof createJobRunner>;
  chains: ChatChains;
  runAsks: ChatRunAsks;
  provider: ReturnType<typeof createJobsProvider>;
  /** Every provider the parent chat opens with, in order; `provider` is its first entry. */
  providers: readonly ToolProvider[];
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
  // Full mode skips the card for every nax-jobs approval (launch, chain, cancel); guarded keeps it.
  const approve: ChatAskController["requestHostApproval"] = (card) => {
    if (options.mode() !== "full") return options.asks.requestHostApproval(card);
    return Promise.resolve(card.signal?.aborted ? "deny" : "allow");
  };
  const provider = _jobsHostDeps.createJobsProvider({
    ...options,
    jobs,
    chains,
    runAsks,
    approve,
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
    providers: hostProviders(options, provider),
    runAsks,
    guard: createJobWriteGuard(jobs, options.repoRoot),
    close,
    sessionChanged,
  };
}
