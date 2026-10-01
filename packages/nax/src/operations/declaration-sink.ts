/**
 * DeclarationSink — mutable shared state scoped to a single rectification cycle.
 *
 * The implementer strategy (writer) pushes declarations here in extractApplied.
 * The postValidate hook reads testEdits + drains mockHandoffs via validateMockStructureFiles.
 * The test-writer strategy reads mockHandoffs to decide appliesTo + drain in buildInput.
 *
 * Mutation is safe: one sink per closure, single-threaded, no cross-story leakage.
 */
import type { TestEditDeclaration } from "./test-edit-declaration";

export interface DeclarationSink {
  testEdits: TestEditDeclaration[];
  mockHandoffs: { files: string[]; reasonDetail: string }[];
}

export function makeDeclarationSink(): DeclarationSink {
  return { testEdits: [], mockHandoffs: [] };
}
