/**
 * Re-export shim — canonical implementation moved to src/agents/audit.ts.
 * Preserved so existing import paths remain valid during the migration window.
 */
export { _promptAuditDeps, buildAuditFilename, findNaxProjectRoot, writePromptAudit } from "../audit";
export type { PromptAuditEntry } from "../audit";
