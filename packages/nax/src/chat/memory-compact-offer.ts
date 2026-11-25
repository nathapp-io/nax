/**
 * memory-compact-offer.ts — the one compaction decision a chat session is offered (US-017).
 *
 * Memory's index is capped, and a project that keeps saving notes eventually cannot fit
 * another one: the save is refused with `MEMORY_FULL` and the only way out is a compaction.
 * The chat is where the notes come from, so the chat is where the question belongs — asked
 * once, without blocking the conversation, and only when there is something to gain.
 *
 * ## One decision per session
 *
 * `check` raises the card only when memory is *nearly* full (`memoryNearlyFull`, which is
 * the configured threshold or an index already dropping entries). Below that it reads the
 * index and returns: a save can be followed by any number of checks and only the one that
 * finds memory near its cap shows anything.
 *
 * The session gets one decision, whatever it is. `later` suppresses the offer for the rest
 * of the session, and so does any compaction *attempt* — applied, invalid, declined,
 * unsupported, unparseable or thrown. Asking a second time after the person said no, or
 * after a compaction already ran, would be nagging; and a mirror that just refused to
 * compact will refuse again. A check that finds memory with room suppresses nothing,
 * because that is the state every early check is in.
 *
 * Two checks that start together share one flight: the chat fires `check` from its start-up
 * and from every save, and two cards for the same question would be two decisions.
 *
 * ## The two cards
 *
 * The ask card names the project (`getProjectKey`, as every memory surface names it), the
 * measured fill and the project's note count, and offers `compact` / `later` with `later` as
 * the fallback — an unanswered card must never spend a model call. The compaction it starts
 * has already been confirmed by that answer, so the `confirm` this file hands over resolves
 * `true` and shows nothing.
 *
 * The result card is the report: one `ok` choice and the applied outcome's own counts, in
 * the same words `nax memory compact` prints, so the two surfaces read alike. It is the only
 * thing the offer shows after an apply; every refusal is a `warn` naming the outcome's kind,
 * because a chat is not a place to fail. A compaction that throws is the same: one `warn`,
 * and the conversation carries on (F15).
 *
 * ## The observer
 *
 * `observe` hands back the host every chat surface should use, with `save` wrapped: the save
 * runs first, answers with the mirror's own result, and only then — in the background, never
 * awaited — starts a check. A save therefore never waits on an ask, a model call or the user.
 * A rejected save rethrows itself untouched and checks nothing: nothing was saved, so there
 * is nothing to react to.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getProjectKey, memoryConfigOf, type NaxConfig } from "@/config";
import type { Logger } from "@/logger";
import {
  compactProjectMemory,
  type MemoryCompactOutcome,
  type MemoryHost,
  memoryIndexFill,
  memoryNearlyFull,
} from "@/memory";
import type { ChatAskController } from "./ask-controller";

/** The stage every line this offer logs is attributed to. */
const STAGE = "chat";

/** The tool name both cards carry: the chat's own, next to `nax-close` and the tool asks. */
const MEMORY_COMPACT_TOOL = "nax-memory-compact";

/** The first card's choices. `later` is also its fallback: an unanswered card compacts nothing. */
const COMPACT_CHOICE = "compact";
const LATER_CHOICE = "later";

/** The result card's single choice, and its fallback — the card reports, it does not decide. */
const OK_CHOICE = "ok";

/** Why the question is being asked, in the card's own words. */
const ASK_REASON = "Memory is close to its size cap; a compaction retires stale notes and merges overlapping ones.";

/** Why the result card is up: the applied compaction can still be undone. */
const RESULT_REASON = "Every note a compaction archived can be restored.";

/**
 * The compaction orchestration this offer calls. Stubbed by tests: a real call reads the
 * repository, dispatches one billed operation and boots a runtime for it.
 */
export const _memoryCompactOfferDeps: { compactProjectMemory: typeof compactProjectMemory } = { compactProjectMemory };

/** The chat's compaction offer: the host it watches, the controller it asks through, the check. */
export interface MemoryCompactOffer {
  /** The host the chat's surfaces should use; its successful saves trigger a check. */
  observe(host: MemoryHost): MemoryHost;
  /** The ask controller the cards go through. Without one, `check` asks nothing at all. */
  attach(asks: ChatAskController): void;
  /** Offer the decision if it is due. Never rejects; never blocks a caller. */
  check(): Promise<void>;
}

/** The index as the whole percent every memory surface speaks in. */
function percent(fill: number): number {
  return Math.round(fill * 100);
}

/** The one line an applied compaction reports: what it changed, the fill it left, the undo. */
function appliedSummary(outcome: Extract<MemoryCompactOutcome, { kind: "applied" }>): string {
  const mergedNotes = outcome.result.merged.reduce((total, merge) => total + merge.from.length, 0);
  const counts = `(${percent(outcome.preview.fillBefore)}% -> ${percent(outcome.fillAfter)}%)`;
  return (
    `Compacted memory: retired ${outcome.result.retired.length}, ` +
    `merged ${mergedNotes} into ${outcome.result.merged.length} ${counts}. ` +
    `Undo: nax memory undo ${outcome.result.id}`
  );
}

/**
 * Create the session's compaction offer.
 *
 * @param input.config - The loaded config: its `memory` block decides the threshold, its `name` the project
 * @param input.repoRoot - The repository whose mirror is being compacted
 * @param input.logger - Where a failed or refused compaction is reported, once
 */
export function createMemoryCompactOffer(input: {
  readonly config: NaxConfig;
  readonly repoRoot: string;
  readonly logger: Pick<Logger, "warn">;
}): MemoryCompactOffer {
  const memory = memoryConfigOf(input.config);
  const project = getProjectKey(input.config, input.repoRoot);
  /** The host `observe` was given; absent until the chat opens memory. */
  let host: MemoryHost | undefined;
  /** The controller the cards go through; absent when the chat has no ask surface. */
  let asks: ChatAskController | undefined;
  /** True once this session has answered, or spent, its one decision. */
  let settled = false;
  /** The check in flight, shared by every call that arrives while it runs. */
  let inFlight: Promise<void> | undefined;

  /** One background line: the offer's whole failure vocabulary. */
  function warn(message: string, data: Record<string, unknown>): void {
    input.logger.warn(STAGE, message, data);
  }

  /**
   * Run the compaction and report it: a result card when it applied, one warn when it did not.
   *
   * The answer that started this was the confirmation, so the orchestration's own `confirm`
   * is already satisfied and shows nothing.
   */
  async function compact(asked: ChatAskController, observed: MemoryHost): Promise<void> {
    let outcome: MemoryCompactOutcome;
    try {
      outcome = await _memoryCompactOfferDeps.compactProjectMemory({
        config: input.config,
        repoRoot: input.repoRoot,
        host: observed,
        dryRun: false,
        confirm: async () => true,
      });
    } catch (error) {
      warn("memory compaction failed", { error: errorMessage(error) });
      return;
    }
    if (outcome.kind !== "applied") {
      warn(`memory compaction did not apply: ${outcome.kind}`, { kind: outcome.kind });
      return;
    }
    await asked.requestHostChoice({
      tool: MEMORY_COMPACT_TOOL,
      summary: appliedSummary(outcome),
      reason: RESULT_REASON,
      fallback: OK_CHOICE,
      choices: [{ id: OK_CHOICE, label: "OK" }],
    });
  }

  /** One offer: read the index, ask if memory is nearly full, then act on the answer. */
  async function offer(): Promise<void> {
    const asked = asks;
    const observed = host;
    if (asked === undefined || observed === undefined || settled) return;
    const index = await observed.renderIndex();
    if (!memoryNearlyFull(index, memory)) return;
    const notes = await observed.notes("project");
    const fill = percent(memoryIndexFill(index, memory.indexBytes));
    const chosen = await asked.requestHostChoice({
      tool: MEMORY_COMPACT_TOOL,
      summary: `Memory for ${project} is ${fill}% full (${notes.length} notes). Compact now?`,
      reason: ASK_REASON,
      fallback: LATER_CHOICE,
      choices: [
        { id: COMPACT_CHOICE, label: "Compact now" },
        { id: LATER_CHOICE, label: "Not now" },
      ],
    });
    // The session's one decision is spent, whatever it was: `later` and every attempt alike.
    settled = true;
    if (chosen !== COMPACT_CHOICE) return;
    await compact(asked, observed);
  }

  /**
   * Offer the decision if it is due, and answer when it is over.
   *
   * Never rejects: an index that cannot be read or a compaction that threw is one warn, so
   * an unawaited call from the chat's start-up cannot become an unhandled rejection. Two
   * calls that arrive while one is running share it rather than asking twice.
   */
  function check(): Promise<void> {
    if (asks === undefined || host === undefined || settled) return Promise.resolve();
    inFlight ??= offer()
      .catch((error) => {
        warn("memory compaction check failed", { error: errorMessage(error) });
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  /** The host the chat's surfaces hold: the one it was given, with a saving observer on top. */
  function observe(observed: MemoryHost): MemoryHost {
    host = observed;
    return {
      ...observed,
      save: async (write) => {
        const result = await observed.save(write);
        // Deliberately not awaited: a save never waits on an ask, a model call or an answer,
        // and `check` swallows its own failures, so nothing here can fail the save.
        void check();
        return result;
      },
    };
  }

  return {
    observe,
    attach(controller: ChatAskController): void {
      asks = controller;
    },
    check,
  };
}
