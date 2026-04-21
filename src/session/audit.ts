/**
 * Session Audit — policy layer for prompt auditing.
 *
 * Owns the "should we audit?" decision and enriches raw adapter-reported
 * entries with stable session identity before delegating to audit-writer.ts.
 *
 * Call site: SessionManager.auditPrompt() — the single entry point for
 * all prompt audit writes in a nax run.
 */

import type { NaxConfig } from "../config";
import { writePromptAudit } from "./audit-writer";
import type { AuditTurnEntry, SessionDescriptor } from "./types";

/**
 * Enrich and write a prompt audit entry. Best-effort — never throws.
 *
 * Adds stable session identity (stableSessionId = descriptor.id) so audit files
 * can be correlated across agent swaps and ACP reconnects using a key that never
 * changes for the lifetime of a logical session.
 */
export function auditTurn(descriptor: SessionDescriptor, entry: AuditTurnEntry, config: NaxConfig): void {
  if (!config.agent?.promptAudit?.enabled) return;

  void writePromptAudit({
    prompt: entry.prompt,
    sessionName: entry.sessionName ?? descriptor.handle ?? descriptor.id,
    stableSessionId: descriptor.id,
    recordId: entry.recordId,
    sessionId: entry.sessionId,
    workdir: descriptor.workdir,
    projectDir: descriptor.projectDir,
    auditDir: config.agent.promptAudit.dir,
    storyId: descriptor.storyId,
    featureName: descriptor.featureName,
    pipelineStage: entry.pipelineStage,
    callType: entry.callType,
    turn: entry.turn,
    resumed: entry.resumed,
  });
}
