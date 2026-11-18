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
function hostProviders(
  options: HostJobsOptions,
  provider: ToolProvider,
  flowOptions: { readonly connection: ReturnType<typeof kodaFlowConnection>; readonly chains: ChatChains },
): readonly ToolProvider[] {
  const { connection, chains } = flowOptions;
  if (connection === undefined) return [provider];
  // When a card is needed, ask directly rather than through the jobs provider's mode-aware
  // wrapper: an outward-facing flow send without chain approval needs a card even in full mode.
  const flow = createFlowProvider({
    repoRoot: options.repoRoot,
    connection,
    chains,
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
  // A card that says it needs a real answer — a chain carrying a handoff — is asked in full mode too.
  const approve: ChatAskController["requestHostApproval"] = (card) => {
    if (card.requiresHostApproval !== true && options.mode() === "full") {
      return Promise.resolve(card.signal?.aborted ? "deny" : "allow");
    }
    return options.asks.requestHostApproval(card);
  };
  const connection = kodaFlowConnection(options.config);
  const provider = _jobsHostDeps.createJobsProvider({
    ...options,
    handoffAvailable: connection !== undefined,
    jobs,
    chains,
    runAsks,
    approve,
    interactionPlugin: options.config.interaction?.plugin ?? "cli",
    ...(options.config.chat?.workflow === undefined ? {} : { workflow: options.config.chat.workflow }),
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
    providers: hostProviders(options, provider, { connection, chains }),
    runAsks,
    guard: createJobWriteGuard(jobs, options.repoRoot),
    close,
    sessionChanged,
  };
}
