/**
 * The `./redact` entry: secret redaction for log lines alone.
 *
 * A light entry point (#3079); see `./credentials.ts` for the contract.
 */
export { capStrings, redactSecrets } from "#src/internal/redact";
