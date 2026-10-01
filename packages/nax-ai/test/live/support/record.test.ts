import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { PiDeps } from "../../../src/protocols/pi-client.ts";
import { recordingDeps } from "./record.ts";

const META = { provider: "p", protocol: "openai-completions", model: "m", api: "openai-completions", note: "test" };

function fakeInner(events: readonly AssistantMessageEvent[], headers: Record<string, string>): PiDeps {
  return {
    resolveModel: async () => ({ id: "m", provider: "p", api: "openai-completions" }) as unknown as Model<Api>,
    stream: (
      _m: Model<Api>,
      _c: Context,
      _o: SimpleStreamOptions,
      onResponse: (response: { readonly status: number; readonly headers: Record<string, string> }) => void,
    ) =>
      (async function* () {
        onResponse({ status: 200, headers });
        for (const e of events) yield e;
      })(),
  };
}

describe("recordingDeps", () => {
  it("captures the events and response that passed through", async () => {
    const doneEvent: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "p",
        model: "m",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    };
    const rec = recordingDeps(fakeInner([doneEvent], { "content-type": "text/event-stream" }), META);
    for await (const _ of rec.deps.stream({} as unknown as Model<Api>, {} as unknown as Context, {}, () => {})) {
      // drain
    }
    rec.write("unit-probe");
    const path = join(import.meta.dirname, "..", "..", "fixtures", "recorded", "unit-probe.json");
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f.events).toEqual([doneEvent]);
    expect(f.response.status).toBe(200);
    expect(f.meta.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    rmSync(path);
  });

  it("drops headers outside the allowlist before they can be committed", async () => {
    const doneEvent: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "p",
        model: "m",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    };
    const rec = recordingDeps(fakeInner([doneEvent], { "set-cookie": "s=1", "retry-after": "30" }), META);
    for await (const _ of rec.deps.stream({} as unknown as Model<Api>, {} as unknown as Context, {}, () => {})) {
      // drain
    }
    rec.write("unit-headers");
    const path = join(import.meta.dirname, "..", "..", "fixtures", "recorded", "unit-headers.json");
    const f = JSON.parse(readFileSync(path, "utf8"));
    expect(f.response.headers).toEqual({ "retry-after": "30" });
    rmSync(path);
  });

  it("still forwards the response to the caller's onResponse", async () => {
    let seen: unknown;
    const rec = recordingDeps(fakeInner([], { "content-type": "x" }), META);
    for await (const _ of rec.deps.stream({} as unknown as Model<Api>, {} as unknown as Context, {}, (r) => {
      seen = r;
    })) {
      // drain
    }
    expect(seen).toEqual({ status: 200, headers: { "content-type": "x" } });
  });
});
