/**
 * The host's `steer` and its `compact` — kept out of `chat-host.ts`, which sits against the
 * 600-line source cap.
 *
 * Steering is a facade delegation and nothing else: the session owns whether a backend can
 * take mid-turn input, whether a turn is running, and what the text's `applied` promise
 * settles to. The host's only own decision is the one a screen's key handler cannot afford to
 * have thrown at it — asking about a host with no session open answers `no_turn` rather than
 * the facade's not-open error, so ctrl+s in an idle chat does nothing instead of drawing a
 * failure.
 *
 * Compaction is a delegation too, and the one place the host adds something of its own: the
 * spend. A manual compaction is not a turn, so no session event carries its usage; the host
 * writes the summarizer call's cost into the ledger and into the session's cumulative total
 * itself, through the same seams a turn's `turn_end` uses (`ChatLedger.record` and the
 * metadata write), so a compacted conversation costs what it actually cost.
 */
import { randomUUID } from "node:crypto";
import type { AgentSession, CompactResult, SessionMeta, SessionStorage, SteerResult } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { ChatLedger, ChatUsageEvent } from "./chat-ledger";
import type { ChatSessionHandle } from "./open-chat-session";

export interface HostSteerInput {
  /** The session the host has open right now, or `undefined` when it has none. */
  readonly session: () => AgentSession | undefined;
}

/** The steering half of the host: what `ChatHost.steer` answers. */
export interface HostSteering {
  steer(text: string): SteerResult;
}

export function createHostSteering(input: HostSteerInput): HostSteering {
  return {
    steer(text: string): SteerResult {
      const session = input.session();
      if (session === undefined) return { status: "no_turn" };
      // A facade that is not the native one has no mid-turn input at all: the screen then
      // interrupts and sends, which is what an `unsupported` brain does too.
      return session.steer?.(text) ?? { status: "unsupported" };
    },
  };
}

export interface HostCompactInput {
  /** The session the host has open right now, or `undefined` when it has none. */
  readonly session: () => AgentSession | undefined;
  /** The whole handle, for the ids and the model a spend row names. */
  readonly handle: () => ChatSessionHandle | undefined;
  readonly storage: SessionStorage;
  /** The process ledger, absent only before the first session was opened. */
  readonly ledger: () => ChatLedger | undefined;
  /** The clock the row's `at` and the metadata it writes are stamped with. */
  readonly now: () => Date;
  /**
   * Adopt the metadata a compaction wrote, so `current()` reports the new spend. The host
   * decides whether the handle it wrote for is still the open one.
   */
  readonly adopt: (meta: SessionMeta) => void;
}

/** The compaction half of the host: what `ChatHost.compact` answers. */
export interface HostCompacting {
  compact(): Promise<CompactResult>;
}

/** Whether a compaction spent anything worth a row: a no-op made no model call at all. */
function spentAnything(result: CompactResult): boolean {
  const { usage } = result;
  return (
    result.costUsd > 0 ||
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    (usage.cacheReadTokens ?? 0) > 0 ||
    (usage.cacheWriteTokens ?? 0) > 0
  );
}

/**
 * The row a compaction's spend arrives as: a synthesized `usage` event, because the
 * summarizer call is not a turn and the session emits no event for it. `round` is 0 — the
 * call belongs to no round of any turn — and the turn id is fresh, so the row is its own
 * scope rather than an addition to the last turn's.
 */
function compactUsageEvent(result: CompactResult, sessionId: string, at: string): ChatUsageEvent {
  const { usage } = result;
  return {
    type: "usage",
    sessionId,
    turnId: randomUUID(),
    round: 0,
    at,
    metadata: {},
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    costUsd: result.costUsd,
  };
}

/**
 * Write one compaction's spend, when it spent anything: a ledger row through the chat
 * ledger's own `record`, and the session metadata's cumulative cost, written to storage and
 * adopted by the host's handle.
 *
 * The metadata is re-read from storage rather than taken from the handle the session was
 * opened with: turns have been adding to it since, and only the stored copy is current.
 */
async function recordSpend(options: {
  readonly input: HostCompactInput;
  readonly handle: ChatSessionHandle;
  readonly result: CompactResult;
  readonly requestedAt: string;
}): Promise<void> {
  const { input, handle, result, requestedAt } = options;
  if (!spentAnything(result)) return;
  const { sessionId, model } = handle.meta;
  const ledger = input.ledger();
  ledger?.record(compactUsageEvent(result, sessionId, input.now().toISOString()), requestedAt, model);
  const stored = (await input.storage.readMeta(sessionId)) ?? handle.meta;
  const meta: SessionMeta = { ...stored, costUsd: (stored.costUsd ?? 0) + result.costUsd };
  await input.storage.writeMeta(meta);
  input.adopt(meta);
  await ledger?.drain();
}

export function createHostCompacting(input: HostCompactInput): HostCompacting {
  return {
    async compact(): Promise<CompactResult> {
      const session = input.session();
      const handle = input.handle();
      if (session === undefined || handle === undefined) {
        throw new NaxError("[chat] no session is open", "CHAT_SESSION_NOT_OPEN", { stage: "chat" });
      }
      const run = session.compact;
      if (run === undefined) {
        throw new NaxError(`[chat] session ${session.id} cannot be compacted`, "CHAT_COMPACT_UNSUPPORTED", {
          stage: "chat",
          sessionId: session.id,
        });
      }
      // The time the compaction was asked for: the row's `previousAt`, so the duration it
      // records is the summarizer call rather than the time since the last turn.
      const requestedAt = input.now().toISOString();
      const result = await run.call(session);
      await recordSpend({ input, handle, result, requestedAt });
      return result;
    },
  };
}
