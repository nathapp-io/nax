/**
 * nax-agent infrastructure (spec R2): the error base class and the process-wide
 * slots nax fills. Imports nothing from nax.
 */

export { type AgentLogger, getLogger, getSafeLogger, setAgentLogger } from "./agent-logger";
export {
  _resetCredentialsConfig,
  type CredentialAuthConfig,
  type CredentialsConfig,
  configureCredentials,
  credentialsConfig,
} from "./credentials-config";
export { NaxError } from "./nax-error";
