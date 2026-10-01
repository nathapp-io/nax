/**
 * AC6 (US-004): WebhookInteractionPlugin's compat-shim lifetime equals the
 * plugin's server lifetime.
 *
 * startServer() installs the port-0 compat shim lazily (SEC-06) and stores
 * the restore. destroy() invokes it via stopServer(). The patch must live
 * exactly as long as the server — and not leak past destroy().
 *
 * This test exercises the receive()/destroy() round trip rather than
 * send()/destroy(): receive() is what guarantees startServer() runs (send()
 * also calls it, but receive() is the path interactive workflows take when
 * there is no upstream webhook responder to POST to).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { WebhookInteractionPlugin } from "@/interaction/plugins/webhook";
import { _resetServePortZeroCompatForTests } from "@/interaction/plugins/webhook-serve-compat";

describe("WebhookInteractionPlugin - compat-shim restore lifetime (US-004 AC6)", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  // `servePortZeroCompatInstalled` is module-level state shared by every test
  // file in this process, so an earlier test left mid-install (or this file's
  // own previous run) would otherwise make the install below a no-op and pass
  // this test vacuously. Force a clean slate instead of re-importing webhook.ts
  // through a cache-busted specifier — that pattern used to instantiate a
  // second module tree purely to reset this one flag, and Bun's coverage
  // instrumentation cannot merge line hits across two instances of the same
  // source file, which corrupted the reported coverage for webhook.ts.
  beforeEach(() => {
    _resetServePortZeroCompatForTests();
  });

  afterEach(() => {
    _resetServePortZeroCompatForTests();
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

  test("AC6: after receive() then destroy(), globalThis.fetch equals the function present before receive()", async () => {
    // Capture the exact function object that exists on the global before the
    // plugin touches anything. This is the value the test will assert against
    // after destroy(); identity (`toBe`) — not port equality — is the contract.
    const fetchBeforeReceive = globalThis.fetch;

    const plugin = new WebhookInteractionPlugin();
    await plugin.init({
      url: "http://127.0.0.1:1/unused", // loopback, never actually contacted
      requireSecret: false, // skip the HMAC gate — this test is about lifetime, not auth
      callbackPort: 0, // auto-assign so we don't collide with anything
    });

    try {
      // receive() triggers startServer(), which lazily calls
      // installServePortZeroCompat(). The 1ms timeout ensures the test does
      // not block waiting for a real callback; receive() resolves as a skip.
      await plugin.receive("req-1", 1);

      // Now destroy(). stopServer() must invoke the restore stored by
      // startServer(), reinstating globalThis.fetch to the pre-receive value.
      await plugin.destroy();

      expect(globalThis.fetch).toBe(fetchBeforeReceive);
    } finally {
      // Safety net for the assertion-failed branch — destroy() restores
      // globals anyway, but if the test throws before reaching destroy()
      // (e.g. because receive() rejects), make sure the afterEach still
      // sees the originals.
      try {
        await plugin.destroy();
      } catch {
        // already destroyed / not started — afterEach restores
      }
    }
  });
});
