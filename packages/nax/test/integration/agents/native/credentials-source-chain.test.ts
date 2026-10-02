/**
 * US-004 — the assembled source chain, proven end to end through a real client.
 *
 * A provider override points an `openai-completions` provider at a loopback
 * OpenAI-compatible server, so what is asserted is the `Authorization` header
 * that actually reaches the wire, not a field handed to a constructor. The store
 * is assembled by `naxCredentialStore()` from `~/.nax/config.json` and
 * `~/.nax/credentials`, both isolated under `NAX_GLOBAL_CONFIG_DIR`.
 *
 * `transportRetries: 0` keeps nax-ai's own retry schedule out of the picture:
 * each transport retry re-reads the store and so re-runs a failing helper, which
 * is not this story's contract.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _resetCredentialStore, buildNativeClient, naxCredentialStore } from "@nathapp/nax-agent/internal";
import type { Client } from "@nathapp/nax-ai";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

const PROVIDER = "opencode-go";
const MODEL_ID = "nax-us004-chain-probe";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let seen: (string | undefined)[];
let entries: LogEntry[];
let unsubscribe: (() => void) | undefined;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;

beforeEach(() => {
  dir = makeTempDir("nax-us004-chain-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  seen = [];

  entries = [];
  resetLogger();
  initLogger({ level: "silent" });
  unsubscribe = addSink((entry) => entries.push(entry));

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(req.headers.get("authorization") ?? undefined);
      const frames = [
        {
          id: "nax-us004",
          object: "chat.completion.chunk",
          created: 0,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
        {
          id: "nax-us004",
          object: "chat.completion.chunk",
          created: 0,
          model: MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ];
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterEach(() => {
  server.stop(true);
  unsubscribe?.();
  resetLogger();
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

async function writeCredential(key: string): Promise<void> {
  await naxCredentialStore().modify(PROVIDER, async () => ({ kind: "api-key", key }));
}

function writeGlobalConfig(auth: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ auth }));
}

/** One-shot helper in the test's global dir, replying with `reply` then exiting 0. */
function writeHelper(reply: string): string {
  const script = join(dir, "helper.sh");
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${reply}'\n`);
  chmodSync(script, 0o755);
  return script;
}

function credentialReply(key: string): string {
  return JSON.stringify({ version: 1, kind: "api-key", key });
}

function declineReply(): string {
  return JSON.stringify({ version: 1, decline: true });
}

async function buildClientAgainstFakeServer(): Promise<Client> {
  return buildNativeClient(
    [
      {
        provider: PROVIDER,
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        models: [
          {
            id: MODEL_ID,
            protocol: "openai-completions",
            contextWindow: 1_000,
            supportsTools: false,
            thinkingLevels: ["off"],
            pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ],
    { transportRetries: 0 },
  );
}

async function request(client: Client): Promise<void> {
  const model = await client.model(PROVIDER, MODEL_ID);
  await client.complete(model, { messages: [{ role: "user", content: "hi" }], maxTokens: 1 });
}

describe("credential source chain through buildNativeClient", () => {
  test("AC19: a credential rewritten between two requests is live on the second — Bearer KEY-B", async () => {
    await writeCredential("KEY-A");
    const client = await buildClientAgainstFakeServer();
    await request(client);

    await writeCredential("KEY-B");
    await request(client);

    expect(seen).toEqual(["Bearer KEY-A", "Bearer KEY-B"]);
  });

  test("AC20: rewriting the credential between two requests logs a credential.changed warn entry", async () => {
    await writeCredential("KEY-A");
    const client = await buildClientAgainstFakeServer();
    await request(client);

    await writeCredential("KEY-B");
    await request(client);

    const changed = entries.filter((entry) => entry.message === "credential.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0].level).toBe("warn");
    expect(changed[0].data).toMatchObject({ providerId: PROVIDER, source: "file" });
  });

  test("AC21: with onChange refuse, no request carries Bearer KEY-B", async () => {
    writeGlobalConfig({ onChange: "refuse" });
    await writeCredential("KEY-A");
    const client = await buildClientAgainstFakeServer();
    await request(client);

    await writeCredential("KEY-B");
    // The refused read throws inside the client, so the completion fails —
    // how it fails is US-005's contract, not this one. What matters is that the
    // second request never reaches the wire.
    await request(client).catch(() => undefined);

    expect(seen).toEqual(["Bearer KEY-A"]);
    expect(seen).not.toContain("Bearer KEY-B");
  });

  test("AC22: with auth.source exec, the request sends Bearer HELPER-KEY", async () => {
    const helper = writeHelper(credentialReply("HELPER-KEY"));
    writeGlobalConfig({ source: "exec", exec: { command: [helper] } });
    const client = await buildClientAgainstFakeServer();

    await request(client);

    expect(seen).toEqual(["Bearer HELPER-KEY"]);
  });

  test("AC23: with auth.source exec and a declining helper, the request sends Bearer FILE-KEY", async () => {
    const helper = writeHelper(declineReply());
    writeGlobalConfig({ source: "exec", exec: { command: [helper] } });
    await writeCredential("FILE-KEY");
    const client = await buildClientAgainstFakeServer();

    await request(client);

    expect(seen).toEqual(["Bearer FILE-KEY"]);
  });
});
