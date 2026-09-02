/**
 * Conversation persistence for the native transport.
 *
 * nax-ai's client is stateless — every call takes the whole message array — so
 * nax keeps the conversation. Under ACP the acpx subprocess remembered it and
 * nax stored nothing; SessionDescriptor still has no message field, and gains
 * none. See ADR-028 sections 2 and 3.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversationMessage } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";

export function transcriptPath(dir: string, sessionName: string): string {
  return join(dir, `${sessionName}.transcript.json`);
}

/** Missing file means a new conversation. Anything else is a real failure. */
export async function loadTranscript(dir: string, sessionName: string): Promise<ConversationMessage[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath(dir, sessionName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  try {
    return JSON.parse(raw) as ConversationMessage[];
  } catch (err) {
    // Deliberately not [] — silently restarting a conversation would drop the
    // history the model is mid-way through and look like a fresh session.
    throw new NaxError(
      `transcript for session "${sessionName}" is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      "TRANSCRIPT_CORRUPT",
      {
        stage: "native-session",
      },
    );
  }
}

export async function saveTranscript(
  dir: string,
  sessionName: string,
  messages: readonly ConversationMessage[],
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(transcriptPath(dir, sessionName), JSON.stringify(messages, null, 2), "utf8");
}

export async function deleteTranscript(dir: string, sessionName: string): Promise<void> {
  await rm(transcriptPath(dir, sessionName), { force: true });
}
