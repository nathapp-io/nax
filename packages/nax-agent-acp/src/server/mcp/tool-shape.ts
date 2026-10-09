/**
 * What the model sees of an MCP tool (S5-5 spec §5.2): a control-stripped,
 * 2 KiB-capped description prefixed with its server, and an input schema that
 * must be a JSON object of type "object" (`$schema` removed, missing
 * `properties` added) within 32 KiB. A schema the provider rejects for other
 * reasons is not contained here.
 */
import type { JSONSchema } from "@nathapp/nax-agent";
import { capBytes, isRecord, stripControl, stripInvisible } from "#src/client/text";

export const MCP_DESCRIPTION_BYTES = 2048;
export const MCP_SCHEMA_BYTES = 32_768;

export type ShapedSchema =
  | { readonly ok: true; readonly schema: JSONSchema }
  | { readonly ok: false; readonly reason: string };

export function shapeDescription(server: string, description: string): string {
  const text = stripInvisible(stripControl(description)).trim();
  return capBytes(text === "" ? `[${server}]` : `[${server}] ${text}`, MCP_DESCRIPTION_BYTES);
}

export function shapeSchema(schema: unknown): ShapedSchema {
  if (!isRecord(schema)) return { ok: false, reason: "input schema is not an object" };
  if (schema.type !== "object") return { ok: false, reason: 'input schema type must be "object"' };
  if (schema.properties !== undefined && !isRecord(schema.properties))
    return { ok: false, reason: "input schema properties must be an object" };
  const { $schema: _dropped, ...rest } = schema;
  const shaped: JSONSchema = { ...rest, properties: schema.properties ?? {} };
  if (Buffer.byteLength(JSON.stringify(shaped), "utf8") > MCP_SCHEMA_BYTES)
    return { ok: false, reason: `input schema is larger than ${MCP_SCHEMA_BYTES} bytes` };
  return { ok: true, schema: shaped };
}
