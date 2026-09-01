import { describe, expect, it } from "vitest";
import { createPiDeps, createPiProtocol } from "../../src/protocols/pi-client.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { piAuthStore } from "./support/pi-auth-store.ts";
import { recordingDeps } from "./support/record.ts";

interface Target {
  readonly fixture: string;
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly api: string;
  readonly request: Omit<ProtocolRequest, "model" | "provider">;
  /** Overrides the generic note when a fixture is evidence of something more. */
  readonly note?: string;
}

const READ_TOOL = {
  name: "read",
  description: "Read a file from disk",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as const;

// Model ids probed from pi-ai 0.84.4's bundled catalog on 2026-08-31. Re-probe with:
//   node -e "import('./dist/providers/pi-catalog.js').then(async m => { for (const p of await m.piProviders(['opencode-go','openai-codex'])) for (const x of p.models) console.log(p.id, x.protocol, x.id) })"
const TARGETS: readonly Target[] = [
  {
    fixture: "opencode-go-anthropic-messages-text",
    provider: "opencode-go",
    protocol: "anthropic-messages",
    model: "minimax-m3",
    api: "anthropic-messages",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
  {
    fixture: "opencode-go-anthropic-messages-tool",
    provider: "opencode-go",
    protocol: "anthropic-messages",
    model: "minimax-m3",
    api: "anthropic-messages",
    request: {
      messages: [{ role: "user", content: "Read the file a.ts using the read tool." }],
      tools: [READ_TOOL],
      maxTokens: 128,
    },
  },
  {
    fixture: "opencode-go-anthropic-messages-thinking",
    provider: "opencode-go",
    protocol: "anthropic-messages",
    model: "minimax-m3",
    api: "anthropic-messages",
    request: {
      messages: [{ role: "user", content: "Think step by step, then read a.ts with the read tool." }],
      tools: [READ_TOOL],
      thinking: "medium",
      maxTokens: 512,
    },
  },
  {
    fixture: "opencode-go-openai-completions-text",
    provider: "opencode-go",
    protocol: "openai-completions",
    model: "deepseek-v4-flash",
    api: "openai-completions",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
  {
    fixture: "opencode-go-openai-responses-text",
    provider: "opencode-go",
    protocol: "openai-responses",
    model: "gpt-5.6-luna",
    api: "openai-responses",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
  },
  {
    // The one first-party target: OpenAI's own Codex OAuth rather than a
    // gateway. It records over SSE because createPiDeps defaults transport to
    // "sse" — pi-ai would otherwise prefer WebSocket here, which has no HTTP
    // response, so onResponse would capture nothing and the fixture could not
    // be evidence of the error-classification path.
    fixture: "openai-codex-responses-text",
    provider: "openai-codex",
    protocol: "openai-codex-responses",
    model: "gpt-5.4-mini",
    api: "openai-codex-responses",
    request: { messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 16 },
    note: 'Recorded from openai-codex, a first-party provider rather than a gateway, over SSE — createPiDeps defaults transport to "sse" because pi-ai would otherwise prefer WebSocket here and no HTTP status could be captured. Evidence of openai-codex-responses event shape and that onResponse observes a real response; not evidence of any error status.',
  },
];

describe("record fixtures from live providers", () => {
  for (const t of TARGETS) {
    it(`records ${t.fixture}`, async () => {
      const rec = recordingDeps(createPiDeps({ credentials: piAuthStore() }), {
        provider: t.provider,
        protocol: t.protocol,
        model: t.model,
        api: t.api,
        note: t.note ?? `Recorded from ${t.provider}. Evidence of ${t.protocol} event shape only.`,
      });
      const protocol = createPiProtocol(t.protocol, rec.deps);

      const events: ProtocolEvent[] = [];
      for await (const e of protocol.stream({ ...t.request, model: t.model, provider: t.provider })) {
        events.push(e);
      }

      const fixture = rec.write(t.fixture);
      expect(events.at(-1)?.type).toBe("done");
      // A recorded status of 0 means onResponse never fired, so the fixture
      // could not be evidence of the error-classification path. That is what
      // WebSocket transport produced for openai-codex before the transport
      // default moved to "sse".
      expect(fixture.response.status).toBe(200);
    }, 120_000);
  }
});
