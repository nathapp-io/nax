import type { FactsManifest } from "@/debate/facts-manifest";
import type { PRD } from "@/prd";
import type { ComposeInput } from "../compose";

/**
 * CriticPromptBuilder — LLM audit for plan ac-testability and failure-mode coverage
 *
 * Generates prompts for the plan-critic LLM to assess:
 * 1. ac-testable: Is each AC assertion observable (file/symbol/test reference)?
 * 2. failure-modes-considered: Does the plan have negative-path coverage?
 */
export class CriticPromptBuilder {
  build(prd: PRD, manifest: FactsManifest): ComposeInput {
    const role: ComposeInput["role"] = {
      id: "role",
      content:
        "You are a plan critic. Your task is to audit acceptance criteria for testability and failure-mode coverage.",
      overridable: false,
    };

    const taskContent = this.buildTaskContent(prd, manifest);

    const task: ComposeInput["task"] = {
      id: "task",
      content: taskContent,
      overridable: false,
    };

    return { role, task };
  }

  private buildTaskContent(prd: PRD, manifest: FactsManifest): string {
    const lines: string[] = [];

    lines.push("## Plan Audit");
    lines.push("");
    lines.push(`Feature: ${prd.feature}`);
    lines.push("");

    lines.push("### Audit Checklist");
    lines.push("");

    lines.push("#### ac-testable");
    lines.push("For each acceptance criterion in the plan:");
    lines.push("- Is the assertion observable? (requires file/symbol/test reference)");
    lines.push("- Emit finding if testability is unclear or missing concrete anchor");
    lines.push("");

    lines.push("#### failure-modes-considered");
    lines.push("For each story in the plan:");
    lines.push("- Does it have at least one negative-path acceptance criterion?");
    lines.push("- Emit finding if no error/exception/boundary case is covered");
    lines.push("");

    lines.push("## Context");
    lines.push("");

    if (manifest.specClaims && manifest.specClaims.length > 0) {
      lines.push("### Spec Claims");
      for (const claim of manifest.specClaims.slice(0, 5)) {
        lines.push(`- ${claim.id}: ${claim.claim}`);
      }
      lines.push("");
    }

    if (manifest.gaps && manifest.gaps.length > 0) {
      lines.push("### Gaps");
      for (const gap of manifest.gaps.slice(0, 5)) {
        lines.push(`- ${gap.id}: ${gap.note}`);
      }
      lines.push("");
    }

    lines.push("## Output Format");
    lines.push("");
    lines.push("Return a JSON object with shape:");
    lines.push("```json");
    lines.push("{");
    lines.push('  "findings": [');
    lines.push(
      '    {"checklistItem": "ac-testable" | "failure-modes-considered", "severity": "blocker" | "major" | "minor", "message": "..."}',
    );
    lines.push("  ]");
    lines.push("}");
    lines.push("```");
    lines.push("");

    return lines.join("\n");
  }

  static jsonRepair(isTruncated: boolean, parseError: string): string {
    const reason = isTruncated
      ? `${parseError} (response also appears near output cap and may be truncated)`
      : parseError;
    return `Your previous response was rejected.

Failure reason: ${reason}

Re-write the complete findings JSON from scratch. Requirements:
- Return exactly one JSON object with a "findings" array.
- Each finding has: checklistItem (string), severity ("blocker"|"major"|"minor"), message (string), and optional specId/gapId/storyId.
- Do not include markdown fences or explanation.
- Output ONLY the JSON object.`;
  }

  static schemaRepair(message: string): string {
    return `Your previous response was rejected.

Failure reason: ${message}

The response was valid JSON but did not match the expected schema. Fix the schema issues and re-emit the complete JSON:
- Root must be an object with a "findings" array.
- Each finding must have "checklistItem" and "severity" fields.
- Do not include markdown fences or explanation.
- Output ONLY the JSON object.`;
  }
}
