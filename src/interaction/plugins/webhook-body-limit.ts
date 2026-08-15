/**
 * SEC-04: bounded-memory request body reader for the webhook callback server.
 *
 * `req.text()` buffers the entire body into memory before any size check can
 * run — a chunked-transfer request with no (or a lying) Content-Length
 * header would be fully read regardless of the configured maxPayloadBytes.
 * This reads the body via a stream reader and aborts the moment accumulated
 * bytes exceed the cap, without draining the rest of the stream.
 */

import { NaxError } from "@/errors";

/** Thrown by {@link readBodyWithLimit} when the accumulated stream exceeds the configured cap. */
export class PayloadTooLargeError extends NaxError {
  constructor() {
    super("Payload exceeds configured maxPayloadBytes", "WEBHOOK_PAYLOAD_TOO_LARGE", { stage: "interaction" });
  }
}

export async function readBodyWithLimit(req: Request, maxBytes: number): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Actively abort the ingest rather than leaving the body half-read
        // and merely unlocked — cancel() signals upstream that we're done
        // consuming, instead of relying on backpressure alone.
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
