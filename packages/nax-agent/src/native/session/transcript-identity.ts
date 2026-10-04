/**
 * Who may resume a transcript, applied by the loop to whatever document any
 * `TranscriptStore` returns (S3 spec 5.5), so the identity rules hold for every
 * store rather than only the file store.
 */

import type { ConversationMessage } from "@nathapp/nax-ai";
import { getLogger, NaxError } from "#src/infra/index";
import { parseModelSpec } from "../models.ts";
import type { TranscriptDoc } from "./transcript-types.ts";

/**
 * Who may resume a transcript. `owner` is the op invocation (nax#1877); `model`
 * is the native model that wrote it (nax#2150, P3 spec 8.3). A field the caller
 * leaves undefined makes no claim, so non-op callers and tests read whatever is
 * there.
 */
export interface TranscriptIdentity {
  readonly owner?: string;
  readonly model?: string;
}

/**
 * The model half of `TranscriptIdentity`: the native `provider/model` id with
 * the reasoning-effort suffix stripped. A thinking signature binds to the
 * model, not to the effort — pi-ai's own `isSameModel` compares
 * provider/api/model for the same reason. `parseModelSpec`, not
 * `parseNativeModel`: this must never throw.
 */
export function transcriptModelIdentity(rawModel: string | undefined): string | undefined {
  return rawModel === undefined ? undefined : parseModelSpec(rawModel).model;
}

/**
 * Another invocation's history (nax#1877) or another model's (nax#2150, P3
 * spec 8.3(c)) reads as a new conversation. An ABSENT document model reads,
 * unlike an absent owner: every native production turn records one (the
 * adapter parses the model before the loop runs), so an absent field is a
 * pre-upgrade file — which the owner check already keeps out of new processes.
 * An owner-less document (including a pre-#1877 bare-array file) is foreign to
 * a reader that has an owner: the cost is one re-exploration, where inheriting
 * it silently bills a conversation this session never had.
 */
function isForeignTranscript(doc: TranscriptDoc, identity: TranscriptIdentity, sessionName: string): boolean {
  const { owner, model } = identity;
  if (owner !== undefined && doc.owner !== owner) {
    getLogger().debug("native-session", "Ignoring a transcript owned by another invocation", {
      sessionName,
      storedOwner: doc.owner,
      owner,
    });
    return true;
  }
  if (model !== undefined && doc.model !== undefined && doc.model !== model) {
    getLogger().debug("native-session", "Ignoring a transcript written by another model", {
      sessionName,
      storedModel: doc.model,
      model,
    });
    return true;
  }
  return false;
}

/**
 * The history a session may resume from a loaded document (nax#1877, nax#2150).
 * An unknown `schemaVersion` fails the turn for the same reason
 * `TRANSCRIPT_CORRUPT` does: silently starting over would drop history the
 * conversation depends on. Both checks run before the owner/model check, so a
 * document this build cannot read fails even when it would be foreign: the
 * reader cannot trust the identity fields of a shape it does not know.
 */
export function historyFromTranscript(
  doc: TranscriptDoc | null,
  identity: TranscriptIdentity,
  sessionName: string,
): readonly ConversationMessage[] {
  if (doc === null) return [];
  const version: unknown = doc.schemaVersion;
  if (version !== undefined && version !== 1) {
    throw new NaxError(
      `transcript for session "${sessionName}" has unsupported schemaVersion ${String(version)}`,
      "TRANSCRIPT_SCHEMA_UNSUPPORTED",
      { stage: "native-session" },
    );
  }
  if (!Array.isArray(doc.messages)) {
    throw new NaxError(
      `transcript for session "${sessionName}" is unreadable: messages is not an array`,
      "TRANSCRIPT_CORRUPT",
      { stage: "native-session" },
    );
  }
  if (isForeignTranscript(doc, identity, sessionName)) return [];
  return doc.messages;
}

/**
 * The document the loop saves. Key order is owner, model, savedAt, messages:
 * the file store writes it as-is, and nax's transcript bytes depend on that order.
 */
export function transcriptDocFor(
  messages: readonly ConversationMessage[],
  identity: TranscriptIdentity,
): TranscriptDoc {
  return {
    ...(identity.owner !== undefined ? { owner: identity.owner } : {}),
    ...(identity.model !== undefined ? { model: identity.model } : {}),
    savedAt: new Date().toISOString(),
    messages: [...messages],
  };
}
