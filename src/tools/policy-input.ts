/** Read a top-level or dot-addressed path-bearing input field. */
export function pathFieldValue(input: Record<string, unknown>, field: string): unknown {
  let value: unknown = input;
  for (const part of field.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
