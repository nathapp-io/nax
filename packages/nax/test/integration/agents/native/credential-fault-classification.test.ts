/**
 * US-005 — a credential fault reaches the adapter as an authentication failure.
 *
 * Entered at `NativeAgentAdapter.complete()`, the seam the story names. Both the
 * global config (`~/.nax/config.json`) and the credential file
 * (`~/.nax/credentials`) are isolated under `NAX_GLOBAL_CONFIG_DIR`, so the store
 * the real nax-ai client reads is the one this test assembled. A provider
 * override points an `openai-completions` provider at a loopback
 * OpenAI-compatible server, so "did the request reach the wire" is observable.
 *
 * nax-ai files every status-less store throw as protocol kind `transport`, so
 * the kind cannot decide the outcome: the `CREDENTIAL_*` code on the cause chain
 * must. Before this story the second case below classified as `fail-service-down`
 * and was retried.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  _clientDeps,
  _resetCredentialStore,
  _resetNativeClient,
  buildNativeClient,
  naxCredentialStore,
} from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NativeAgentAdapter } from "@/agents/native-agent";
import type { ResolvedCompleteOptions } from "@/agents/types";
import type { ProviderCatalogOverride } from "@/config/schema-types";
import { initLogger, resetLogger } from "@/logger";

const PROVIDER = "opencode-go";
const MODEL_ID = "nax-us005-credential-fault-probe";

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let seen: string[];
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const REAL_BUILD = _clientDeps.build;

/** An SSE completion the openai-completions protocol can parse to a clean finish. */
function completionBody(): string {
  const frames = [
    {
      id: "nax-us005",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    {
      id: "nax-us005",
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
}

beforeEach(() => {
  dir = makeTempDir("nax-us005-fault-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _resetNativeClient();
  // test/preload.ts sentinels _clientDeps.build so no test builds a real client
  // by accident. The adapter reaches the client through getNativeClient, which
  // has no transportRetries seam of its own — the real builder with its default
  // 2-retry schedule is what production uses, and the story accepts that backoff
  // (each nax-ai retry re-reads the store and so re-runs the failing helper).
  _clientDeps.build = buildNativeClient;
  resetLogger();
  initLogger({ level: "silent" });

  seen = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push(req.headers.get("authorization") ?? "");
      return new Response(completionBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterEach(() => {
  server.stop(true);
  resetLogger();
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _resetCredentialStore();
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  cleanupTempDir(dir);
});

/** The provider override that points the provider at the loopback server. */
function overrides(): ProviderCatalogOverride[] {
  return [
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
  ];
}

/** `modelDef.provider` is deliberately the ignored value, as in production. */
function completeOptions(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "unknown", model: `${PROVIDER}/${MODEL_ID}` },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all", bashApproval: "raw" },
  };
}

function writeGlobalConfig(auth: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ auth }));
}

/** A helper that reads and discards stdin, then fails. */
function writeFailingHelper(): string {
  const script = join(dir, "failing-helper.sh");
  writeFileSync(script, "#!/bin/sh\ncat > /dev/null\nexit 1\n");
  chmodSync(script, 0o755);
  return script;
}

async function writeCredential(key: string): Promise<void> {
  await naxCredentialStore().modify(PROVIDER, async () => ({ kind: "api-key", key }));
}

describe("US-005 — credential faults at NativeAgentAdapter.complete()", () => {
  test("US-005 AC12: a failing exec helper makes complete() return adapterFailure.outcome fail-auth", async () => {
    writeGlobalConfig({ source: "exec", exec: { command: [writeFailingHelper()] } });

    const result = await new NativeAgentAdapter(undefined, overrides()).complete("hi", completeOptions());

    expect(result.adapterFailure?.outcome).toBe("fail-auth");
  });

  test("US-005 AC13: with onChange refuse, a credential rewritten between two complete() calls makes the second fail-auth", async () => {
    writeGlobalConfig({ onChange: "refuse" });
    await writeCredential("KEY-A");

    const adapter = new NativeAgentAdapter(undefined, overrides());

    const first = await adapter.complete("hi", completeOptions());
    expect(first.adapterFailure).toBeUndefined();
    expect(seen).toEqual(["Bearer KEY-A"]);

    await writeCredential("KEY-B");
    const second = await adapter.complete("hi", completeOptions());

    expect(second.adapterFailure?.outcome).toBe("fail-auth");
    // The refusal happens at the credential read, before the request is built —
    // the run must not continue on an account it never agreed to bill.
    expect(seen).toEqual(["Bearer KEY-A"]);
  });
});
