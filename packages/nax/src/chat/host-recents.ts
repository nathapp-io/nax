/**
 * The host's recent-model list: when it is written, and what `/model` reads.
 *
 * Kept out of `chat-host.ts` — which sits against the 600-line source cap — so the host only
 * says *when* a model was used and this file owns what that means. There are three such
 * moments, and each passes the model the session actually landed on rather than the string the
 * caller requested: a clamped effort is what the screen would re-apply, so a clamped effort is
 * what is remembered.
 *
 * The in-memory list is updated before the write. A store that cannot be saved therefore costs
 * a warning and nothing else: the switch the user asked for stays successful, and the rows the
 * picker draws are still the ones just used.
 */
import type { Logger } from "@/logger";
import { type RecentModelStore, recordRecentModel } from "./recent-models";
import type { SwitchOutcome } from "./session-switch";

export interface HostRecentsInput {
  readonly store: RecentModelStore;
  /** The list the store held when the host was composed. */
  readonly initial: readonly string[];
  readonly logger: Pick<Logger, "warn">;
}

/** The host's recent-model bookkeeping: what the picker reads and the three recording points. */
export interface HostRecents {
  recentModels(): readonly string[];
  /** A session was opened on `model` and stayed there. */
  recordOpen(model: string): Promise<void>;
  /**
   * A switch settled. Only a switch that both succeeded and moved the session off `fromModel`
   * records: a rollback or a reuse of the live session leaves the list alone.
   */
  switched(fromModel: string, outcome: Pick<SwitchOutcome, "error" | "handle">): Promise<void>;
}

export function createHostRecents(input: HostRecentsInput): HostRecents {
  let models: readonly string[] = input.initial;

  async function record(model: string): Promise<void> {
    const next = recordRecentModel(models, model);
    // Adopted before the write: a list that cannot be persisted must not make the session the
    // user is on disappear from the rows they just saw.
    models = next;
    try {
      await input.store.save(next);
    } catch (error) {
      input.logger.warn("chat", "Failed to save the recently used models", { error, model });
    }
  }

  return {
    recentModels: () => models,
    recordOpen: record,
    async switched(fromModel, outcome) {
      const landed = outcome.handle.meta.model;
      if (outcome.error !== undefined || landed === fromModel) return;
      await record(landed);
    },
  };
}
