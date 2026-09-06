#!/usr/bin/env bun

/**
 * Where does pi-ai put `cache_control` markers on an anthropic-messages request?
 *
 * Written for nax#1878, where MiniMax-M2.7 returned ~3% prompt-cache hits while
 * MiniMax-M3 returned 86-99% on the same code paths in the same run. The
 * hypothesis under test was that pi-ai shapes the two requests differently. It
 * does not: both get a system marker plus one on the last user message, at every
 * turn depth. See docs/2026-09-06-pi-ai-migration-assessment.md section 4.
 *
 * Reaches no network and spends nothing: `fetch` is stubbed and the response is
 * an immediately-terminated SSE stream. Run with `bun run
 * scripts/probes/cache-control-placement.ts`.
 *
 * The technique generalises. pi-ai's per-model format tables are gated by flags
 * that live elsewhere, so reading a table tells you what pi-ai *could* send, not
 * what it does. Capture the request instead.
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/** Placeholder accounting for a replayed assistant turn. Never sent upstream. */
const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A conversation of `turns` user messages with assistant replies between them. */
function conversation(turns: number): unknown[] {
  const messages: unknown[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `question ${i}`, timestamp: 0 });
    if (i === turns - 1) continue;
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `answer ${i}` }],
      api: "anthropic-messages",
      provider: "minimax",
      model: "m",
      usage: NO_USAGE,
      stopReason: "stop",
      timestamp: 0,
    });
  }
  return messages;
}

/** Every position in the request body carrying a cache_control marker. */
function markers(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  const system = body.system;
  if (Array.isArray(system)) {
    system.forEach((block, i) => {
      if ((block as { cache_control?: unknown } | null)?.cache_control) found.push(`system[${i}]`);
    });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach((message, i) => {
    const entry = message as { role?: string; content?: unknown; cache_control?: unknown };
    const content = Array.isArray(entry.content) ? entry.content : [];
    content.forEach((block, j) => {
      if ((block as { cache_control?: unknown } | null)?.cache_control) {
        found.push(`messages[${i}].content[${j}] (${entry.role})`);
      }
    });
    if (entry.cache_control) found.push(`messages[${i}] (${entry.role})`);
  });
  return found;
}

const models = builtinModels();

for (const id of ["MiniMax-M2.7", "MiniMax-M3"]) {
  const model = models.getModel("minimax", id);
  if (model === undefined) {
    console.log(`${id}: not in the bundled catalog`);
    continue;
  }
  console.log(`\n=== ${id}  compat=${JSON.stringify(model.compat ?? null)} ===`);

  for (const turns of [2, 4]) {
    let body: Record<string, unknown> = {};
    const stubFetch: typeof fetch = async (_input, init) => {
      try {
        body = JSON.parse(String(init?.body ?? "{}"));
      } catch {
        body = {};
      }
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    try {
      const stream = models.streamSimple(
        model,
        // biome-ignore lint/suspicious/noExplicitAny: pi-ai's Context is shaped by hand here
        { systemPrompt: "STABLE SYSTEM PROMPT", messages: conversation(turns) } as any,
        { apiKey: "sk-test", sessionId: "SID", cacheRetention: "short", fetch: stubFetch, transport: "sse" },
      );
      for await (const _event of stream) {
        // drain: the stub response ends the stream immediately
      }
    } catch {
      // The stub response is not a real completion; the body was captured before it mattered.
    }

    const found = markers(body);
    const count = Array.isArray(body.messages) ? body.messages.length : 0;
    console.log(`  ${turns} user turns -> ${count} msgs; markers: ${found.length > 0 ? found.join(" | ") : "NONE"}`);
  }
}
