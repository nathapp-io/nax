/**
 * Append an ACP turn to the native chat document.
 *
 * The ACP backend owns only its ACP record and cost baseline, so a chat
 * session that switches to a native model replays the native document
 * (`TranscriptDoc.messages`) and would otherwise resume with no history. This
 * appends the turn to that document instead: load, then save the document with
 * the new messages. A document that does not exist yet is created as
 * `{ savedAt, messages }`, which reads as a native document (`checkBackendKind`)
 * because it carries no `backend`.
 *
 * Recording is best-effort: the turn already happened, so a failed load or save
 * must not fail the send. It is logged as a warning and forgotten.
 */
import type { TranscriptDoc, TranscriptStore } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { ChatMessage } from "./acp-history";

const LOG_STAGE = "chat";
const RECORD_FAILED = "could not record the ACP turn";

function withTurn(doc: TranscriptDoc | null, messages: readonly ChatMessage[], savedAt: string): TranscriptDoc {
  if (doc === null) return { savedAt, messages };
  return { ...doc, savedAt, messages: [...doc.messages, ...messages] };
}

/**
 * Append messages to the native chat document: load, then save
 * `{ ...doc, savedAt, messages: [...doc.messages, ...messages] }`, or `{ savedAt, messages }` when
 * there is no document. Never throws: a load or save rejection is logged with
 * getLogger().warn("chat", "could not record the ACP turn", { sessionId, error: errorMessage(error) }).
 */
export async function appendNativeTurn(
  store: TranscriptStore,
  sessionId: string,
  messages: readonly ChatMessage[],
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    const doc = await store.load(sessionId);
    await store.save(sessionId, withTurn(doc, messages, now().toISOString()));
  } catch (error) {
    getLogger().warn(LOG_STAGE, RECORD_FAILED, { sessionId, error: errorMessage(error) });
  }
}
