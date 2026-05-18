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
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _acpAdapterDeps } from "../src/agents/acp/adapter";

const isolatedGlobalDir = mkdtempSync(join(tmpdir(), "nax-test-global-"));

process.env.NAX_GLOBAL_CONFIG_DIR = isolatedGlobalDir;
delete process.env.NAX_RUNS_DIR;

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
