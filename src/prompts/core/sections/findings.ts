/**
 * Findings Section
 *
 * Builds the "REVIEW FINDINGS" section used by RectifierPromptBuilder (Phase 5).
 * Exported from core/sections so it is accessible to builders without coupling
 * them to the plugins module directly.
 */

import type { ReviewFinding } from "../../../plugins/types";
import type { PromptSection } from "../types";

export type { ReviewFinding };

export function findingsSection(findings: ReviewFinding[]): PromptSection | null {
  if (findings.length === 0) return null;
  const body = findings
    .map((f, i) => {
      const head = `## Finding ${i + 1} — ${f.severity.toUpperCase()}: ${f.ruleId}`;
      const loc = `File: ${f.file}:${f.line}`;
      const msg = `Message: ${f.message}`;
      return [head, loc, msg].join("\n");
    })
    .join("\n\n");
  return {
    id: "findings",
    overridable: false,
    content: `# REVIEW FINDINGS\n\n${body}`,
  };
}
