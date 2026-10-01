/**
 * US-006 — the native adapter stamps the credential identity that served a call
 * onto the result it returns.
 *
 * A provider override points an `openai-completions` provider at a loopback
 * OpenAI-compatible server, so what is asserted is a real `complete()` /
 * `sendTurn()` return value whose credential was read from a real (isolated)
 * `~/.nax/credentials` or exec helper. The store is assembled by
 * `naxCredentialStore()` from `~/.nax/config.json` and `~/.nax/credentials`,
 * both isolated under `NAX_GLOBAL_CONFIG_DIR`.
 *
 * `transportRetries: 0` keeps nax-ai's own retry schedule out of the picture:
 * each transport retry re-reads the store and so re-runs a failing helper, which
 * is not this story's contract.
 *
 * Acceptance criteria covered: AC1, AC2, AC3, AC4, AC5.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient, buildNativeClient } from "@/agents/native/client";
import { _resetCredentialStore, naxCredentialStore, servedAuth } from "@/agents/native/credentials";
import { toSessionModel } from "@/agents/session-model-mapping";
import type { SessionHandle, TurnResult } from "@/agents/session-types";
import type { ResolvedPermissions } from "@/config/permissions";
import type { ModelDef, ProviderCatalogOverride } from "@/config/schema-types";

const PROVIDER = "opencode-go";
const MODEL_ID = "nax-us006-auth-probe";
/** `provider` is the guess `resolveModel()` infers for a non-Claude id — the adapter must ignore it. */
const MODEL_DEF: ModelDef = { provider: "unknown", model: `${PROVIDER}/${MODEL_ID}` };
const PERMS: ResolvedPermissions = { mode: "approve-reads", bashApproval: "raw" };

let dir: string;
let server: ReturnType<typeof Bun.serve>;
const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
const originalBuild = _clientDeps.build;

beforeEach(() => {
  dir = makeTempDir("nax-us006-auth-");
  process.env.NAX_GLOBAL_CONFIG_DIR = dir;
  _resetCredentialStore();
  _resetNativeClient();
  // test/preload.ts sentinels _clientDeps.build; un-sentinel it for the real
  // builder, which is the only way `NativeAgentAdapter.complete()` reaches the
  // loopback server through its catalog override.
  _clientDeps.build = async (overrides) => buildNativeClient(overrides, { transportRetries: 0 });

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      const frames = [
        {
          id: "nax-us006",
          object: "chat.completion.chunk",
          created: 0,
          model: MODEL_ID,
          choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
        },
        {
          id: "nax-us006",
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
  _clientDeps.build = originalBuild;
  _resetNativeClient();
  process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
  _resetCredentialStore();
  cleanupTempDir(dir);
});

function catalogOverride(): ProviderCatalogOverride {
  return {
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
  };
}

/** An adapter wired to the override that points at this test's loopback server. */
function adapter(): NativeAgentAdapter {
  return new NativeAgentAdapter(undefined, [catalogOverride()]);
}

function completeOptions(modelDef: ModelDef = MODEL_DEF): {
  modelDef: ModelDef;
  workdir: string;
  resolvedPermissions: ResolvedPermissions;
} {
  return { modelDef, workdir: dir, resolvedPermissions: PERMS };
}

async function writeCredential(key: string): Promise<void> {
  await naxCredentialStore().modify(PROVIDER, async () => ({ kind: "api-key", key }));
}

function writeGlobalConfig(auth: Record<string, unknown>): void {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ auth }));
}

/** One-shot helper in this test's global dir, replying with `reply` then exiting 0. */
function writeHelper(reply: string): string {
  const script = join(dir, "helper.sh");
  writeFileSync(script, `#!/bin/sh\ncat > /dev/null\nprintf '%s' '${reply}'\n`);
  chmodSync(script, 0o755);
  return script;
}

function credentialReply(key: string, account?: string): string {
  return JSON.stringify(
    account === undefined ? { version: 1, kind: "api-key", key } : { version: 1, kind: "api-key", key, account },
  );
}

async function openTurnSession(name: string): Promise<SessionHandle> {
  return adapter().openSession(name, {
    agentName: "native",
    workdir: dir,
    resolvedPermissions: PERMS,
    modelDef: toSessionModel(MODEL_DEF),
    timeoutSeconds: 60,
    transcriptDir: dir,
  });
}

function send(a: NativeAgentAdapter, handle: SessionHandle): Promise<TurnResult> {
  return a.sendTurn(handle, "hi", { interactionHandler: { onInteraction: async () => ({ answer: "" }) } });
}

describe("NativeAgentAdapter.complete() — auth stamp (US-006)", () => {
  // AC1 (success): the credential came from the file store, so the returned
  // stamp's source says so rather than defaulting to something else.
  test("AC1: complete() with a file api-key returns auth.source 'file'", async () => {
    await writeCredential("FILE-KEY");

    const result = await adapter().complete("hi", completeOptions());

    expect(result.auth?.source).toBe("file");
  });

  // AC2 (success): the fingerprint on the result is the one the guard holds for
  // the provider parsed from `modelDef.model`.
  test("AC2: complete() returns auth.fingerprint equal to servedAuth(provider).fingerprint", async () => {
    await writeCredential("FILE-KEY");

    const result = await adapter().complete("hi", completeOptions());

    const served = servedAuth(PROVIDER);
    expect(served).toBeDefined();
    expect(result.auth?.fingerprint).toBe(served?.fingerprint);
  });

  // AC2 boundary: the provider is read from the model id, so a
  // `modelDef.provider` that names a DIFFERENT provider than the model id's
  // prefix must not change which credential is reported. Pinning this keeps an
  // implementer from reaching for `modelDef.provider`, which is "unknown" for
  // every non-Claude model.
  test("AC2 boundary: the fingerprint follows the model id's provider, not options.modelDef.provider", async () => {
    await writeCredential("FILE-KEY");

    const result = await adapter().complete("hi", completeOptions({ provider: "anthropic", model: MODEL_DEF.model }));

    const served = servedAuth(PROVIDER);
    expect(served).toBeDefined();
    expect(result.auth?.fingerprint).toBe(served?.fingerprint);
  });

  // AC3 (success): the account label the exec helper reported reaches the stamp.
  test("AC3: with auth.source exec and a helper reporting account 'team-a', complete() returns auth.account 'team-a'", async () => {
    const helper = writeHelper(credentialReply("HELPER-KEY", "team-a"));
    writeGlobalConfig({ source: "exec", exec: { command: [helper] } });
    _resetCredentialStore();
    _resetNativeClient();

    const result = await adapter().complete("hi", completeOptions());

    expect(result.auth?.account).toBe("team-a");
  });

  // AC3 boundary: an exec-served credential is reported as coming from "exec",
  // so an account label is never attached to a file-store stamp.
  test("AC3 boundary: an exec-served credential returns auth.source 'exec'", async () => {
    const helper = writeHelper(credentialReply("HELPER-KEY", "team-a"));
    writeGlobalConfig({ source: "exec", exec: { command: [helper] } });
    _resetCredentialStore();
    _resetNativeClient();

    const result = await adapter().complete("hi", completeOptions());

    expect(result.auth?.source).toBe("exec");
  });
});

describe("NativeAgentAdapter.sendTurn() — auth stamp (US-006)", () => {
  // AC4 (success): the turn result carries the credential that served it.
  test("AC4: sendTurn() with a file api-key returns auth.source 'file'", async () => {
    await writeCredential("FILE-KEY");
    const a = adapter();
    const handle = await a.openSession("nax-us006-turn-file", {
      agentName: "native",
      workdir: dir,
      resolvedPermissions: PERMS,
      modelDef: toSessionModel(MODEL_DEF),
      timeoutSeconds: 60,
      transcriptDir: dir,
    });

    const turn = await send(a, handle);

    expect(turn.auth?.source).toBe("file");
  });

  // AC5 (success): the fingerprint comes from the provider parsed out of
  // `handle.modelDef.model`.
  test("AC5: sendTurn() returns auth.fingerprint equal to servedAuth(provider).fingerprint", async () => {
    await writeCredential("FILE-KEY");
    const a = adapter();
    const handle = await openTurnSession("nax-us006-turn-fingerprint");

    const turn = await send(a, handle);

    const served = servedAuth(PROVIDER);
    expect(served).toBeDefined();
    expect(turn.auth?.fingerprint).toBe(served?.fingerprint);
  });

  // AC5 boundary: a turn served by the helper reports the helper's account, so
  // the same credential identity reaches both entry points.
  test("AC5 boundary: an exec-served turn reports the helper's account 'team-b'", async () => {
    const helper = writeHelper(credentialReply("HELPER-KEY", "team-b"));
    writeGlobalConfig({ source: "exec", exec: { command: [helper] } });
    _resetCredentialStore();
    _resetNativeClient();
    const a = adapter();
    const handle = await openTurnSession("nax-us006-turn-exec");

    const turn = await send(a, handle);

    expect(turn.auth?.account).toBe("team-b");
  });
});
