/**
 * nax-agent infrastructure (spec R2): the error base class and the process-wide
 * slots nax fills. Imports nothing from nax.
 */

export { type AgentLogger, getLogger, getSafeLogger, setAgentLogger } from "./agent-logger.ts";
export {
  _resetCredentialsConfig,
  type CredentialAuthConfig,
  type CredentialsConfig,
  configureCredentials,
  credentialsConfig,
} from "./credentials-config.ts";
export { NaxError } from "./nax-error.ts";
