/**
 * Bun test preload — runs once before any test file in this process.
 *
 * Redirects global nax state into a temp directory so tests never write to the
 * real ~/.nax, while still starting from a deterministic clean environment.
 *
 * Also installs a sentinel on _acpAdapterDeps.createClient that throws if
 * called without a test-level mock, preventing accidental real acpx session
 * leaks. To allow real spawns (rare), override the dep in your describe block:
 *   _acpAdapterDeps.createClient = mock(() => makeClient(makeSession()));
 *
 * Same idea for _clientDeps.build (the native/nax-ai client): unmocked, it
 * builds a real client that gets memoised in client.ts's module-level cache
 * for the rest of the process — any later test relying on its own
 * _clientDeps.build override then silently gets the real client instead.
 * Fail fast here instead.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _acpAdapterDeps } from "../src/agents/acp/adapter";
import { _clientDeps } from "../src/agents/native/client";
import { _notifyDeps } from "../src/finish/notify";

const isolatedGlobalDir = mkdtempSync(join(tmpdir(), "nax-test-global-"));

process.env.NAX_GLOBAL_CONFIG_DIR = isolatedGlobalDir;
delete process.env.NAX_RUNS_DIR;

// ─── Outbound-notification isolation ──────────────────────────────────────────
// telegramCreds() falls back to these ambient env vars when config carries no
// interaction block. Redirecting ~/.nax does NOT isolate env, so a developer
// with real Telegram credentials exported would have the suite send them live
// messages. Scrub them before any test file loads.
delete process.env.NAX_TELEGRAM_TOKEN;
delete process.env.NAX_TELEGRAM_CHAT_ID;
delete process.env.TELEGRAM_BOT_TOKEN;

// ─── Console suppression ──────────────────────────────────────────────────────
// Suppress all console output in tests. Tests that need to capture output
// should override _deps.log / _deps.warn in a local beforeEach, not rely on
// global console. Tests that intentionally test console output (e.g. logger
// unit tests) override console.log locally with their own capture functions.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// ─── ACP spawn sentinel ───────────────────────────────────────────────────────
// Blocks real acpx sessions from being created in tests. Any test that calls
// code leading to _acpAdapterDeps.createClient without first mocking it will
// fail fast with a clear message instead of leaking into the acpx session
// registry. To opt in to a real client, replace this dep in beforeEach/afterEach.
_acpAdapterDeps.createClient = () => {
  throw new Error(
    "[test-preload] _acpAdapterDeps.createClient called without a mock — " +
      "this would spawn a real acpx session and pollute the session registry. " +
      "Add to your describe block:\n" +
      "  beforeEach(() => { _acpAdapterDeps.createClient = mock(() => makeClient(makeSession())); })\n" +
      "  afterEach(() => { _acpAdapterDeps.createClient = <saved original>; mock.restore(); })",
  );
};

// ─── Native client sentinel ───────────────────────────────────────────────────
// Blocks a real @nathapp/nax-ai client from being built and memoised in
// client.ts's module-level cache. Without this, any test that reaches
// NativeAgentAdapter without mocking _clientDeps.build (e.g. via
// isInstalled()/hasCredentials() through getInstalledAgents() or
// checkAgentHealth()) builds a real client that then silently overrides
// every later test file's own _clientDeps.build mock, since getNativeClient()
// only calls the builder once. To opt in to a real client, replace the dep in
// your describe block and clear the cache afterward.
_clientDeps.build = () => {
  throw new Error(
    "[test-preload] _clientDeps.build called without a mock — " +
      "this would build a real nax-ai client and cache it for the rest of the " +
      "process, silently overriding every later test's own mock. " +
      "Add to your describe block:\n" +
      "  beforeEach(() => { _clientDeps.build = mock(async () => fakeClient); })\n" +
      "  afterEach(() => { _clientDeps.build = <saved original>; _resetNativeClient(); })",
  );
};

// ─── Telegram send sentinel ───────────────────────────────────────────────────
// Second line of defence behind the env scrub above: any test that supplies
// explicit credentials via config and reaches the notifier would otherwise POST
// to the real Bot API. Fail fast instead of messaging a human.
_notifyDeps.fetch = () => {
  throw new Error(
    "[test-preload] _notifyDeps.fetch called without a mock — " +
      "this would send a REAL Telegram message. Override the notifier in your describe block:\n" +
      "  beforeEach(() => { _notifyDeps.fetch = mock(async () => new Response(null, { status: 200 })); })\n" +
      "  afterEach(() => { _notifyDeps.fetch = <saved original>; })",
  );
};
