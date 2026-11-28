/**
 * The `./credentials` entry: the credentials slot alone.
 *
 * A light entry point (#3079). An always-on embedder installs the slot at
 * startup through this file without loading the session, tool, sandbox or
 * provider code behind the root entry. The slot is the same module instance
 * the root entry re-exports, so a value installed here is the one a session
 * reads later.
 *
 * Keep the module graph small: `test/unit/packaging/light-subpaths.test.ts`
 * pins every file this entry loads.
 */
export type { CredentialAuthConfig, CredentialsConfig } from "#src/infra/credentials-config";
export { configureCredentials } from "#src/infra/credentials-config";
