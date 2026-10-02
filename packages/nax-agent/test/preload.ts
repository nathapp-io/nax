/**
 * Bun test preload for nax-agent: runs once before any test file.
 *
 * The parts of packages/nax/test/preload.ts the moved tests rely on: global state
 * redirected to a temp directory, the credentials slot filled the way nax's CLI
 * fills it, provider keys scrubbed from the environment, console silenced, and a
 * sentinel on the native client builder so no test caches a real nax-ai client.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CredentialAuthConfig, configureCredentials } from "#src/infra/index";
import { _clientDeps } from "#src/native/client";

const isolatedGlobalDir = mkdtempSync(join(tmpdir(), "nax-agent-test-global-"));
process.env.NAX_GLOBAL_CONFIG_DIR = isolatedGlobalDir;
delete process.env.NAX_RUNS_DIR;

const configDir = (): string => process.env.NAX_GLOBAL_CONFIG_DIR || isolatedGlobalDir;

/** nax's global auth section with its schema defaults (packages/nax/src/config/schemas-auth.ts). */
async function readAuthConfig(): Promise<CredentialAuthConfig> {
  const file = Bun.file(join(configDir(), "config.json"));
  const config: { auth?: Partial<CredentialAuthConfig> } = (await file.exists()) ? await file.json() : {};
  const auth = config.auth ?? {};
  const exec = auth.exec === undefined ? undefined : { ...auth.exec, timeoutMs: auth.exec.timeoutMs ?? 10_000 };
  return { source: auth.source ?? "file", onChange: auth.onChange ?? "warn", ...(exec === undefined ? {} : { exec }) };
}

configureCredentials({ configDir, readAuthConfig });

for (const key of Object.keys(process.env)) {
  if (/_API_KEY$/.test(key)) delete process.env[key];
}

console.log = () => {};
console.warn = () => {};
console.error = () => {};

_clientDeps.build = () => {
  throw new Error(
    "[test-preload] _clientDeps.build called without a mock: it would build a real nax-ai client " +
      "and cache it for the rest of the process. Mock it in your describe block and call _resetNativeClient() after.",
  );
};
