/**
 * Vocabulary shared by the tool-input validator (`src/agents/native/session/
 * tool-input-validation.ts`, nax#2047) and `run-command.ts`'s own `values`
 * shape guard (#1924): the "actual" half of a violation reads exactly the
 * way run-command.ts itself would have phrased the same shape, so the gate
 * and the tool produce the same wording.
 */
export function describeValuesType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
