/**
 * US-004 — the native adapter's credential probe with an exec helper configured.
 *
 * Split out of adapter.test.ts: the RED commit for this story took that file
 * past the 800-line test-file limit (check:file-sizes), and `hasCredentials`
 * is the concern this story changed. The tests themselves are unchanged.
 *
 * The probe answers "can this agent authenticate to anything?" without asking
 * the helper: a helper's providers cannot be listed, so an empty credential
 * file says nothing, and spawning one here would read a credential before the
 * run has any reason for it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _adapterDeps } from "#src/native/adapter-deps";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

describe("hasCredentials — exec credential source (US-004)", () => {
  test("AC18: returns true without spawning the helper when auth.source is exec and no credential file exists", async () => {
    const dir = makeTempDir("nax-adapter-exec-");
    const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    try {
      process.env.NAX_GLOBAL_CONFIG_DIR = dir;
      const marker = join(dir, "helper-ran");
      const script = join(dir, "helper.sh");
      writeFileSync(
        script,
        `#!/bin/sh\ntouch '${marker}'\ncat > /dev/null\nprintf '%s' '{"version":1,"kind":"api-key","key":"HELPER-KEY"}'\n`,
      );
      chmodSync(script, 0o755);
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ auth: { source: "exec", exec: { command: [script] } } }),
      );

      // Nothing stored and nothing ambient: only the exec source can make this
      // true, and a helper's providers cannot be listed, so it is not asked.
      _adapterDeps.listStoredProviders = async () => [];
      _adapterDeps.anyAmbientCredential = async () => false;

      expect(await new NativeSessionAdapter().hasCredentials()).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
      cleanupTempDir(dir);
    }
  });

  test('AC18 boundary: with auth.source "file", an empty store and no ambient auth it is still false', async () => {
    const dir = makeTempDir("nax-adapter-file-");
    const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    try {
      process.env.NAX_GLOBAL_CONFIG_DIR = dir;
      writeFileSync(join(dir, "config.json"), JSON.stringify({ auth: { source: "file" } }));

      _adapterDeps.listStoredProviders = async () => [];
      _adapterDeps.anyAmbientCredential = async () => false;

      expect(await new NativeSessionAdapter().hasCredentials()).toBe(false);
    } finally {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
      cleanupTempDir(dir);
    }
  });
});
