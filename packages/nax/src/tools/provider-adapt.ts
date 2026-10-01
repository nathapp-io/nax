/**
 * Namespacing and adaptation of provider tools into plain CodingTools.
 *
 * The namespaced name is NEVER parsed back apart. That is what lets a local
 * name contain `__` without escaping, and it is why the ledger carries an
 * explicit `provider` field rather than expecting a consumer to string-split.
 */
import { NaxError } from "@/errors";
import type { ProviderTool } from "./provider-types";
import { validateProviderId } from "./provider-types";
import type { CodingTool } from "./registry";
import { RESERVED_TOOL_NAMES } from "./registry";

export function namespacedToolName(providerId: string, localName: string): string {
  validateProviderId(providerId);
  if (localName.length === 0) {
    throw new NaxError(`provider ${providerId} advertised a tool with an empty name`, "PROVIDER_TOOL_NAME_EMPTY");
  }
  const name = `${providerId}__${localName}`;
  if ((RESERVED_TOOL_NAMES as readonly string[]).includes(name)) {
    throw new NaxError(`provider tool ${name} collides with a built-in`, "PROVIDER_TOOL_NAME_RESERVED");
  }
  return name;
}

export function adaptProviderTool(providerId: string, tool: ProviderTool): CodingTool {
  return {
    name: namespacedToolName(providerId, tool.localName),
    description: tool.description,
    inputSchema: tool.inputSchema,
    // No path fields and no verb field: the grant lookup is the whole gate,
    // which is the honest expression for a tool whose arguments are not paths.
    scope: { pathFields: [] },
    run: (input, ctx) => tool.run(input, ctx),
  };
}
