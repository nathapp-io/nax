import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PiDeps, PiResponse } from "../../../src/protocols/pi-client.ts";
import { HEADER_ALLOWLIST, type RecordedFixture, type RecordedMeta } from "../../support/fixture-types.ts";

const DIR = join(import.meta.dirname, "..", "..", "fixtures", "recorded");

function filterHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const allowed = new Set<string>(HEADER_ALLOWLIST);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => allowed.has(k.toLowerCase())));
}

/**
 * Wraps PiDeps to capture what pi actually sent, at the seam the mapper reads
 * from. Recording the mapper's OUTPUT instead — which is what M2 did — cannot
 * catch a mapping regression: a wrong mapping would simply be re-recorded as
 * the new expectation.
 */
export function recordingDeps(
  inner: PiDeps,
  meta: Omit<RecordedMeta, "recordedAt">,
): { deps: PiDeps; write: (name: string) => RecordedFixture } {
  const events: AssistantMessageEvent[] = [];
  let response: PiResponse = { status: 0, headers: {} };

  const deps: PiDeps = {
    resolveModel: inner.resolveModel,
    stream: (model, context, options, onResponse) =>
      (async function* () {
        for await (const event of inner.stream(model, context, options, (r) => {
          response = { status: r.status, headers: filterHeaders(r.headers) };
          onResponse(r);
        })) {
          events.push(event);
          yield event;
        }
      })(),
  };

  // Returns what it wrote, so a caller can assert on the captured response.
  // `status` is 0 until onResponse fires, which is the signature of a
  // transport that carries no HTTP response at all.
  const write = (name: string): RecordedFixture => {
    const file = join(DIR, `${name}.json`);
    mkdirSync(dirname(file), { recursive: true });
    const body: RecordedFixture = {
      meta: { ...meta, recordedAt: new Date().toISOString().slice(0, 10) },
      response,
      events,
    };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    return body;
  };

  return { deps, write };
}
