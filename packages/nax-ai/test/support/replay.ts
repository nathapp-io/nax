import type { Api, Model } from "@earendil-works/pi-ai";
import { createPiProtocol, type PiDeps } from "../../src/protocols/pi-client.ts";
import type { Protocol, ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import type { RecordedFixture } from "./fixture-types.ts";

/** The mapper reads only id, provider and api off the model, so a fixture's
 *  meta is enough — resolving a real catalog entry would put the network back
 *  into a test whose whole point is not having one. */
function stubModel(fixture: RecordedFixture): Model<Api> {
  return {
    id: fixture.meta.model,
    provider: fixture.meta.provider,
    api: fixture.meta.api,
  } as unknown as Model<Api>;
}

function depsFor(fixture: RecordedFixture): PiDeps {
  return {
    resolveModel: async () => stubModel(fixture),
    // A new generator per call: runProtocolConformance drains the same
    // protocol repeatedly, and a single consumed iterable would leave every
    // test after the first asserting on an empty stream.
    stream: (_model, _context, _options, onResponse) =>
      (async function* () {
        onResponse(fixture.response);
        for (const event of fixture.events) yield event;
      })(),
  };
}

export function protocolFromFixture(fixture: RecordedFixture): Protocol {
  return createPiProtocol(fixture.meta.protocol, depsFor(fixture));
}

export async function drainFixture(
  fixture: RecordedFixture,
  req: Partial<ProtocolRequest> = {},
): Promise<ProtocolEvent[]> {
  const request: ProtocolRequest = {
    model: fixture.meta.model,
    provider: fixture.meta.provider,
    messages: [{ role: "user", content: "replay" }],
    ...req,
  };
  const events: ProtocolEvent[] = [];
  for await (const event of protocolFromFixture(fixture).stream(request)) events.push(event);
  return events;
}
