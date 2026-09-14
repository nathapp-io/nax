import type { ToolInputViolation } from "./tool-input-validation";

export function exemplarFor(
  schema: unknown,
  input: Record<string, unknown>,
  violation: ToolInputViolation,
): Record<string, unknown> {
  const exemplar: Record<string, unknown> = { ...input };

  if (violation.property === "") {
    return exemplar;
  }

  if (!isPlainObject(schema)) return exemplar;
  const properties = schema.properties;
  if (!isPlainObject(properties)) return exemplar;
  const propSchema = properties[violation.property];
  if (!isPlainObject(propSchema)) {
    exemplar[violation.property] = "<FILL IN>";
    return exemplar;
  }

  const propType = propSchema.type;
  if (propType === "string") {
    exemplar[violation.property] = `<FILL IN: ${violation.property}>`;
  } else if (propType === "number" || propType === "integer") {
    exemplar[violation.property] = 0;
  } else if (propType === "boolean") {
    exemplar[violation.property] = false;
  } else if (propType === "null") {
    exemplar[violation.property] = null;
  } else if (propType === "array") {
    exemplar[violation.property] = [`<FILL IN: ${violation.property}>`];
  } else if (propType === "object") {
    const subProperties = propSchema.properties;
    if (isPlainObject(subProperties)) {
      const subExemplar: Record<string, unknown> = {};
      for (const key of Object.keys(subProperties)) {
        subExemplar[key] = "<FILL IN>";
      }
      exemplar[violation.property] = subExemplar;
    } else {
      exemplar[violation.property] = { "<FILL IN>": "<FILL IN>" };
    }
  } else if (Array.isArray(propSchema.enum) && propSchema.enum.every((m) => typeof m === "string")) {
    exemplar[violation.property] = (propSchema.enum as readonly string[])[0];
  } else {
    exemplar[violation.property] = "<FILL IN>";
  }

  return exemplar;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
