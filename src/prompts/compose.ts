/**
 * Prompt Composition
 *
 * composeSections() assembles a canonical ordered list of PromptSection objects
 * from a structured ComposeInput. join() serialises them into a final prompt string.
 *
 * This module must NOT import from the src/prompts barrel (circular dependency).
 * Import from leaf modules only.
 */

import type { PromptSection, SectionSlot } from "./core/types";
import { SLOT_ORDER } from "./core/types";
import { SECTION_SEP, wrapConstitution } from "./core/wrappers";

/** Structured input for composeSections(). Each field maps to a slot or an unslotted section. */
export interface ComposeInput {
  /** Unslotted — role/persona text for the agent. Always rendered last (after slotted sections). */
  readonly role: PromptSection;
  /** Unslotted — task description. Always rendered after role (after slotted sections). */
  readonly task: PromptSection;
  /** Optional raw constitution string. Rendered first via wrapConstitution(). */
  readonly constitution?: string;
  /** Optional instructions section — rendered in "instructions" slot position. */
  readonly instructions?: PromptSection;
  /** Optional input section — rendered in "input" slot position. */
  readonly input?: PromptSection;
  /** Optional candidates section — rendered in "candidates" slot position. */
  readonly candidates?: PromptSection;
  /** Optional JSON schema section — rendered in "json-schema" slot position. */
  readonly jsonSchema?: PromptSection;
}

/**
 * Assemble an ordered list of PromptSection objects from a ComposeInput.
 *
 * Rendering order:
 * 1. Slotted sections in SLOT_ORDER (constitution → instructions → input → candidates → json-schema)
 * 2. Unslotted sections in declaration order (role → task)
 *
 * Empty-content sections (after trimming) are filtered out.
 */
export function composeSections(input: ComposeInput): readonly PromptSection[] {
  const slotMap: Partial<Record<SectionSlot, PromptSection>> = {};

  if (input.constitution) {
    slotMap.constitution = {
      id: "constitution",
      content: wrapConstitution(input.constitution),
      overridable: true,
      slot: "constitution",
    };
  }

  if (input.instructions) {
    slotMap.instructions = { ...input.instructions, slot: "instructions" };
  }

  if (input.input) {
    slotMap.input = { ...input.input, slot: "input" };
  }

  if (input.candidates) {
    slotMap.candidates = { ...input.candidates, slot: "candidates" };
  }

  if (input.jsonSchema) {
    slotMap["json-schema"] = { ...input.jsonSchema, slot: "json-schema" };
  }

  const slotted: PromptSection[] = SLOT_ORDER.flatMap((slot) => {
    const s = slotMap[slot];
    return s?.content.trim() ? [s] : [];
  });

  const unslotted: PromptSection[] = [input.role, input.task].filter((s): s is PromptSection => !!s.content.trim());

  return [...slotted, ...unslotted];
}

/**
 * Serialise an ordered list of PromptSection objects into a single prompt string.
 * Sections are joined with SECTION_SEP ("\n\n---\n\n").
 */
export function join(sections: readonly PromptSection[]): string {
  return sections.map((s) => s.content).join(SECTION_SEP);
}
