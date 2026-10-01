#!/usr/bin/env bun
/**
 * Manual probe: proves the nax-ai tool round-trip end-to-end against a real
 * provider (complete() -> toolCalls -> tool-result message -> coherent
 * continuation).
 *
 * This is a standalone script, not a bun:test file, because test/preload.ts
 * installs three deliberate isolation guards that a live provider call
 * cannot pass under `bun test` in this repo, and should not be made to pass:
 *   1. `_clientDeps.build` is replaced with a thrower, so no test can build
 *      a real nax-ai client (or memoise one into the process-wide cache).
 *   2. `NAX_GLOBAL_CONFIG_DIR` is redirected to an empty temp dir, so
 *      `naxCredentialStore()` never sees the real `~/.nax/credentials`.
 *   3. Every env var matching `/_API_KEY$/` is deleted, stripping the
 *      ambient-credential fallback too.
 * Running this file with `bun scripts/probe-native-tool-round-trip.ts`
 * instead of `bun test` means preload.ts never loads, so none of those
 * guards apply and none of them are subverted.
 *
 * Costs money and needs a real openrouter credential (`nax auth login` or
 * an ambient `OPENROUTER_API_KEY`). Run manually only:
 *
 *   bun scripts/probe-native-tool-round-trip.ts
 *
 * This is the manual gate for ADR-028's tool-loop assumption — the premise
 * every later native-sessions task builds on. It is not run in CI.
 */

import { getNativeClient } from "../src/agents/native/client";

async function main(): Promise<void> {
  const client = await getNativeClient();
  const model = await client.model("openrouter", "deepseek/deepseek-v4-flash");

  const tools = [
    {
      name: "get_secret_number",
      description: "Returns the secret number. Call this when asked for it.",
      inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    },
  ];

  const first = await client.complete(model, {
    messages: [{ role: "user", content: "What is the secret number? Use the tool." }],
    tools,
  });

  const call = first.toolCalls?.[0];
  if (!call) {
    console.error("FAIL: no tool call in the first response.");
    console.error("first.text:", first.text);
    process.exit(1);
  }
  console.log("Tool call:", JSON.stringify(call));

  if (call.name !== "get_secret_number") {
    console.error(`FAIL: expected tool call "get_secret_number", got "${call.name}".`);
    process.exit(1);
  }

  const second = await client.complete(model, {
    messages: [
      { role: "user", content: "What is the secret number? Use the tool." },
      { role: "assistant", content: first.text, toolCalls: first.toolCalls },
      { role: "tool-result", toolCallId: call.id, content: "42" },
    ],
    tools,
  });

  console.log("Continuation:", second.text);

  if (!second.text.includes("42")) {
    console.error('FAIL: continuation does not contain the fed-back value "42".');
    process.exit(1);
  }

  console.log("OK: tool round-trip produced a coherent continuation.");
}

main().catch((err: unknown) => {
  console.error("FAIL:", err);
  process.exit(1);
});
