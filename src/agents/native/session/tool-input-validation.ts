/**
 * Fail-open subset validator for tool inputs (nax#2047).
 *
 * The model returned RunCommand calls with `values:""` 69 times and
 * `values:"\t"` 13 times in a row -- the empty string produced no rejected
 * keys, the tab became the key "0", and neither message ever named "values"
 * itself as the wrong type, so the loop could not break. This validator
 * catches that shape at the transport boundary so a malformed input never
 * persists in the transcript.
 *
 * The contract is a strict subset of JSON Schema on purpose: type, enum,
 * required, and a `properties` object. Anything we cannot decide -- unknown
 * keywords such as `anyOf`, a missing or non-object schema, extra properties
 * with no `additionalProperties` -- returns `undefined` (allow), so this
 * validator never breaks a tool that was previously passing.
 *
 * `null` on a property the schema does not list as `required` is treated as
 * absent (nax#2200). The tools already read it that way (`Git` treats a
 * non-array `refs` as `[]`), and models routinely spell "not supplied" as
 * `null`; rejecting it made the gate stricter than the tools it guards, and a
 * verifier that sent `refs: null` three times lost its turn to the budget.
 * `stripNullOptionals` removes those properties so the handler sees the same
 * "absent" the validator judged.
 */
import { describeValuesType } from "@/utils/describe-value-type";

export interface ToolInputViolation {
  // The offending property's name, e.g. "values" (including a missing
  // `required` entry -- see below). validateToolInput here always names a
  // property; "" is reserved for a top-level violation with no single
  // property to point at, which this validator does not currently produce.
  readonly property: string;
  readonly expected: string; // "object", "one of: a, b, c", "present"
  readonly actual: string; // "a string", "null", "an array", "absent"
  readonly message: string; // one sentence, names the property and both shapes
}

export function validateToolInput(schema: unknown, input: unknown): ToolInputViolation | undefined {
  if (!isPlainObject(schema)) return undefined;
  const { properties, required, type } = schema;
  if (!isPlainObject(properties)) return undefined;
  if (type !== undefined && type !== "object") return undefined;
  if (!isPlainObject(input)) return undefined;

  const requiredKeys = requiredSet(required);
  for (const entry of requiredKeys) {
    if (!(entry in input)) {
      return {
        property: entry,
        expected: "present",
        actual: "absent",
        message: `\`${entry}\` is required`,
      };
    }
  }

  for (const key of Object.keys(input)) {
    const propSchema = properties[key];
    if (!isPlainObject(propSchema)) continue;
    const value = input[key];
    // nax#2200: `null` on an optional property reads as "not supplied".
    if (value === null && !requiredKeys.has(key)) continue;

    if (typeof propSchema.type === "string" && PRIMITIVE_TYPES.has(propSchema.type)) {
      if (!typeMatches(propSchema.type, value)) {
        const expected = propSchema.type;
        const actual = describeValuesType(value);
        return {
          property: key,
          expected,
          actual,
          message: `\`${key}\` expected ${expected}, got ${actual}`,
        };
      }
    }

    const enumSchema = propSchema.enum;
    if (Array.isArray(enumSchema) && enumSchema.every((m) => typeof m === "string")) {
      if (!enumSchema.includes(value as string)) {
        const expected = `one of: ${enumSchema.join(", ")}`;
        const actual = describeValuesType(value);
        return {
          property: key,
          expected,
          actual,
          message: `\`${key}\` must be ${expected} (got ${actual})`,
        };
      }
    }
  }

  return undefined;
}

/**
 * The input with every `null`-valued optional property removed, or `undefined`
 * when there is nothing to remove (including any schema the validator does not
 * understand — the same fail-open contract). A property whose own schema
 * declares `type: "null"` keeps its value: there `null` IS the supplied value.
 * Never mutates `input`.
 */
export function stripNullOptionals(schema: unknown, input: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(schema) || !isPlainObject(input)) return undefined;
  const { properties, required, type } = schema;
  if (!isPlainObject(properties)) return undefined;
  if (type !== undefined && type !== "object") return undefined;

  const requiredKeys = requiredSet(required);
  const stripped = Object.keys(input).filter((key) => {
    const propSchema = properties[key];
    if (input[key] !== null || requiredKeys.has(key) || !isPlainObject(propSchema)) return false;
    return propSchema.type !== "null";
  });
  if (stripped.length === 0) return undefined;
  const drop = new Set(stripped);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !drop.has(key)));
}

function requiredSet(required: unknown): ReadonlySet<string> {
  if (!Array.isArray(required)) return new Set();
  return new Set(required.filter((entry): entry is string => typeof entry === "string"));
}

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "null",
  "object",
]);

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
