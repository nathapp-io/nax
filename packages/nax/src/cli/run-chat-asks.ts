import { isAbsolute } from "node:path";
import { CHAT_ASKS_FLAG } from "../interaction";
import { getSafeLogger } from "../logger";

export const CHAT_ASK_SECRET_READ_MS = 5_000;
const SECRET_HEX_LENGTH = 64;
type TimerHandle = ReturnType<typeof setTimeout> | number;

export const _runChatAsksDeps = {
  // The read deadline must be cancelled once stdin supplies its line.
  setTimeout: (callback: () => void, ms: number): TimerHandle => setTimeout(callback, ms),
  clearTimeout: (handle: TimerHandle | undefined): void => clearTimeout(handle),
};

export type ChatAsksFlag = { ok: true; value: string | undefined } | { ok: false; message: string };

export function parseChatAsksFlag(raw: string | undefined): ChatAsksFlag {
  if (raw === undefined || isAbsolute(raw)) return { ok: true, value: raw };
  return { ok: false, message: `${CHAT_ASKS_FLAG} must be an absolute path` };
}

/** Read only the first newline-terminated line, keeping at most 64 ASCII characters. */
async function readSecretLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array | undefined> {
  let line = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return undefined;
    for (const byte of value) {
      if (byte === 10) {
        if (!/^[a-f\d]{64}$/i.test(line)) return undefined;
        return Uint8Array.from(Buffer.from(line, "hex"));
      }
      if (line.length >= SECRET_HEX_LENGTH) return undefined;
      line += String.fromCharCode(byte);
    }
  }
}

/** Consume the one-use stdin secret; invalid, missing or late input disables chat asks. */
export async function readChatAskSecret(
  stream: ReadableStream<Uint8Array>,
  timeoutMs: number = CHAT_ASK_SECRET_READ_MS,
): Promise<Uint8Array | undefined> {
  let timer: TimerHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = stream.getReader();
    const deadline = new Promise<undefined>((resolve) => {
      timer = _runChatAsksDeps.setTimeout(() => resolve(undefined), timeoutMs);
    });
    const result = await Promise.race([readSecretLine(reader), deadline]);
    if (!result) getSafeLogger()?.warn("chat-asks", "[chat-asks] Missing or invalid stdin secret; disabling chat asks");
    return result;
  } catch {
    getSafeLogger()?.warn("chat-asks", "[chat-asks] Could not read stdin secret; disabling chat asks");
    return undefined;
  } finally {
    _runChatAsksDeps.clearTimeout(timer);
    // Cancel a pending read on timeout. Do not wait for a producer's cancellation hook.
    // Promise.race already observes the losing read's rejection.
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}
