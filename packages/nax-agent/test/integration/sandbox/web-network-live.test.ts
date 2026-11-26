import { afterAll, expect, test } from "bun:test";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { realOrRaw } from "#src/internal/realpath";
import { createCommandLauncher, probeSandbox } from "#src/sandbox/index";
import { buildSandboxPolicy } from "#src/sandbox/policy-builder";
import { createSrtBackend } from "#src/sandbox/srt-backend";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

const backend = createSrtBackend({ allowedDomains: ["*"] });
const probe = await probeSandbox(backend);
const label = probe.available ? "available" : `SKIPPED: ${probe.reason}`;
afterAll(() => backend.reset());

test.skipIf(!probe.available)(
  `AC-20: live proxy refuses example.com after network swap (${label})`,
  async () => {
    const root = realOrRaw(makeTempDir("web-network-live-"));
    try {
      const launcher = createCommandLauncher({
        state: { kind: "available", backend: "srt", network: ["*"] },
        backend,
        policyFor: async () =>
          buildSandboxPolicy({
            root,
            git: { kind: "none" },
            gitGuardFiles: [],
            naxEntries: [],
            credentialFiles: [],
            ownedPaths: EMPTY_OWNED_PATHS_POLICY,
            home: root,
            tempRoots: [root],
            platform: process.platform,
            config: { ...DEFAULT_SANDBOX_CONFIG, network: { allowedDomains: ["*"] } },
          }),
      });
      // CONNECT is rejected locally by srt after the swap, before any upstream connection.
      assertDefined(backend.updateNetwork);
      await backend.updateNetwork(["registry.npmjs.org"]);
      const result = await launcher.run({
        spec: { kind: "shell", shell: "/bin/sh", command: "curl -sv --max-time 10 https://example.com 2>&1" },
        root,
        cwd: root,
        timeoutMs: 20_000,
        stripEnvVars: [],
      });
      expect(result.sandbox?.wrapped).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("403 Forbidden");
      expect(result.stdout).toContain("X-Proxy-Error: blocked-by-allowlist");
    } finally {
      cleanupTempDir(root);
    }
  },
  30_000,
);
