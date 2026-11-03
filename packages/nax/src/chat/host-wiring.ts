/**
 * The chat host's two ordering rules, kept out of `chat-host.ts` so the host itself
 * stays a composition point rather than a sequence of `try`/`finally` blocks.
 *
 * **Handler order.** The resources' plugin handlers run first, then the
 * rule-delivery pair, then the memory flush, then the `nax-jobs` write guard. A
 * compaction therefore forgets a session's delivered rule bodies before memory
 * syncs, and the memory entry never sits ahead of a rule nudge or behind a write
 * guard — the guard is the last word on a call, and memory's flush is not a
 * decision about it at all.
 *
 * **Close order.** `closeChatResources` retires the session, the background tasks,
 * the resources and the interaction chain, collecting the first failure and
 * rethrowing it. The memory flush runs in a `finally` after all of that: a
 * teardown that rejects still leaves the mirror synced, and the teardown's own
 * error is the one the caller sees.
 */
import type { LoopHandlerSet } from "@nathapp/nax-agent";
import { createRuleDeliveryHandlers, type RuleDeliveryInput } from "@/context/rules/rule-delivery";
import type { HostMemory } from "./host-memory";
import { closeChatResources } from "./session-hygiene";

export interface ChatLoopHandlerInput {
  /** The handlers the resources' plugins contributed; they run before every built-in. */
  readonly pluginHandlers?: LoopHandlerSet;
  /** `config.context.rules`: the override layer the rule-delivery pair reads. */
  readonly rules: Pick<RuleDeliveryInput, "overrideDir" | "overrideMode">;
  readonly repoRoot: string;
  /** The host's memory handlers; empty when the chat has no memory host. */
  readonly memory: LoopHandlerSet;
  /** The `nax-jobs` write guard, absent on a host with no jobs entry. */
  readonly guard?: LoopHandlerSet;
}

/** Every loop handler one chat session installs, in dispatch order. */
export function createChatLoopHandlers(input: ChatLoopHandlerInput): LoopHandlerSet {
  return Object.freeze([
    ...(input.pluginHandlers ?? []),
    ...createRuleDeliveryHandlers({
      repoRoot: input.repoRoot,
      overrideDir: input.rules.overrideDir,
      overrideMode: input.rules.overrideMode,
    }),
    ...input.memory,
    ...(input.guard ?? []),
  ]);
}

/** What `closeChatResources` already needs, plus the memory side to flush after it. */
export type CloseChatHostInput = Parameters<typeof closeChatResources>[0] & {
  /** The host's memory side: one last sync, after every resource teardown has run. */
  readonly memory: Pick<HostMemory, "closeSync">;
};

/** Retire the host's resources, then flush memory whatever that teardown did. */
export async function closeChatHost(input: CloseChatHostInput): Promise<void> {
  const { memory, ...resources } = input;
  try {
    await closeChatResources(resources);
  } finally {
    await memory.closeSync();
  }
}
