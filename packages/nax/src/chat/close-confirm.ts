import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Logger } from "@/logger";
import type { ChatAskController } from "./ask-controller";

interface CloseConfirmOptions {
  readonly hostJobs?: {
    readonly jobs: {
      owned(): readonly { readonly id: string }[];
      cancel(id: string): Promise<unknown>;
    };
    readonly chains: { stop(reason: string): void };
  };
  readonly tasks?: {
    running(): readonly { readonly id: string }[];
    stopAll(): Promise<void>;
  };
  readonly asks: ChatAskController;
  readonly logger: Pick<Logger, "warn">;
}

async function cancelOwned(options: CloseConfirmOptions, owned: readonly { readonly id: string }[]): Promise<void> {
  for (const job of owned) {
    try {
      await options.hostJobs?.jobs.cancel(job.id);
    } catch (cause) {
      options.logger.warn("chat", "Failed to cancel nax job on close", { jobId: job.id, error: errorMessage(cause) });
    }
  }
}

/** Decide whether to quit without irreversibly closing the host's job controller. */
export function createCloseConfirm(options: CloseConfirmOptions): () => Promise<boolean> {
  return async () => {
    const owned = options.hostJobs?.jobs.owned() ?? [];
    const running = options.tasks?.running() ?? [];
    const decision =
      owned.length || running.length
        ? await options.asks.requestHostChoice({
            tool: "nax-close",
            summary: `${owned.length} nax job(s) and ${running.length} background command(s) still running: ${[...owned, ...running].map((item) => item.id).join(", ")}`,
            reason: "Background commands stop when the chat quits. Detached nax jobs can be left running.",
            fallback: "stay",
            choices: [
              { id: "stop", label: "Quit and stop them" },
              ...(owned.length
                ? [{ id: "leave", label: "Quit and leave nax jobs running (background commands stop)" }]
                : []),
              { id: "stay", label: "Stay in chat" },
            ],
          })
        : "stop";
    if (decision !== "stop" && decision !== "leave") return false;
    options.hostJobs?.chains.stop("the chat closed");
    if (decision === "stop") await cancelOwned(options, owned);
    await options.tasks?.stopAll();
    return true;
  };
}
