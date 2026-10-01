import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PiResponse } from "../../src/protocols/pi-client.ts";

/** Only these reach a committed fixture. `retry-after` is the one the mapper
 *  reads; the rest are provenance. Anything else is dropped rather than
 *  trusted to be harmless in a public repository. */
export const HEADER_ALLOWLIST = ["retry-after", "content-type", "x-request-id"] as const;

export interface RecordedMeta {
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly api: string;
  readonly recordedAt: string;
  /** What this fixture is evidence of, and what it is NOT. */
  readonly note: string;
}

export interface RecordedFixture {
  readonly meta: RecordedMeta;
  readonly response: PiResponse;
  readonly events: readonly AssistantMessageEvent[];
}
