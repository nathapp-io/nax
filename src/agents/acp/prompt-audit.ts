/**
 * @deprecated Re-export shim — all prompt-audit logic has moved to src/session/audit-writer.ts (#523).
 * This file exists for backward compatibility with existing importers.
 * Import directly from "../../session/audit-writer" in new code.
 */
export {
  _promptAuditDeps,
  buildAuditFilename,
  findNaxProjectRoot,
  writePromptAudit,
} from "../../session/audit-writer";
export type { PromptAuditEntry } from "../../session/audit-writer";
