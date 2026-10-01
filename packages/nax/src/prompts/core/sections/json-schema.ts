/**
 * JSON Schema Section
 *
 * Describes the expected JSON output format for one-shot LLM prompts.
 * Used by ReviewPromptBuilder (Phase 3) and OneShotPromptBuilder (Phase 6).
 */

import type { PromptSection } from "../types";

export interface SchemaDescriptor {
  name: string;
  description: string;
  example: unknown;
}

export function jsonSchemaSection(schema: SchemaDescriptor): PromptSection {
  return {
    id: "json-schema",
    overridable: false,
    content: [
      "# OUTPUT FORMAT (JSON)",
      "",
      schema.description,
      "",
      `Schema name: ${schema.name}`,
      "",
      "Example:",
      "```json",
      JSON.stringify(schema.example, null, 2),
      "```",
    ].join("\n"),
  };
}
