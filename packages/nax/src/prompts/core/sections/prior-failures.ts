/**
 * Prior Failures Section
 *
 * Builds the "PRIOR FAILURES" section used by acceptance and rectifier builders.
 * Exported from core/sections so both AcceptancePromptBuilder (Phase 4) and
 * RectifierPromptBuilder (Phase 5) can import without duplication.
 */

import type { PromptSection } from "../types";

export interface FailureRecord {
  test?: string;
  file?: string;
  message: string;
  output?: string;
}

export function priorFailuresSection(failures: FailureRecord[]): PromptSection | null {
  if (failures.length === 0) return null;
  const body = failures
    .map((f, i) => {
      const head = `## Failure ${i + 1}${f.test ? ` — ${f.test}` : ""}`;
      const loc = f.file ? `File: ${f.file}` : "";
      const msg = `Message: ${f.message}`;
      const out = f.output ? `\n\nOutput:\n\`\`\`\n${f.output}\n\`\`\`` : "";
      return [head, loc, msg].filter(Boolean).join("\n") + out;
    })
    .join("\n\n");
  return {
    id: "prior-failures",
    overridable: false,
    content: `# PRIOR FAILURES\n\n${body}`,
  };
}
