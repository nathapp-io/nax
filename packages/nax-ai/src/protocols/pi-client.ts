/**
 * The single adapter from pi-ai's event stream to `PiStreamEvent`.
 *
 * This is the only place outside a backend file that imports pi-ai. It exists
 * so every protocol backend consumes one narrow, testable shape rather than
 * pi-ai's full vocabulary.
 *
 * NOTE FOR THE IMPLEMENTER: pi-ai's `Models.stream()` returns an
 * `AssistantMessageEventStream`. Read `node_modules/@earendil-works/pi-ai/dist/utils/event-stream.d.ts`
 * and `dist/types.d.ts` for the event union before writing this mapping, and
 * add a test per event kind you map.
 */

import type { PiClientPort } from "./anthropic-messages/backend-pi.ts";

export async function createPiClient(_protocolName: string): Promise<PiClientPort> {
  throw new Error(
    "createPiClient is not implemented yet — see Task 6 notes. Backends are testable via injection in the meantime.",
  );
}
