import type { ProviderTool, ToolResult, ToolRunContext } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { PrRef } from "@/forge";
import { redactSecrets } from "@/logger";

/** Handler definitions validate before resolving any forge context. */
export interface ForgeToolDefinition extends Pick<ProviderTool, "localName" | "description" | "inputSchema"> {
  validate(input: Record<string, unknown>): string | undefined;
  read(ref: PrRef, input: Record<string, unknown>, ctx: ToolRunContext): Promise<ToolResult>;
}

/** Common fail-safe boundary for every downstream read handler. */
export function wrapForgeTool(definition: ForgeToolDefinition, resolveRef: () => Promise<PrRef>): ProviderTool {
  return {
    localName: definition.localName,
    description: definition.description,
    inputSchema: definition.inputSchema,
    async run(input, ctx) {
      try {
        const invalid = definition.validate(input);
        if (invalid) return { isError: true, content: invalid };
        return await definition.read(await resolveRef(), input, ctx);
      } catch (error) {
        const redacted = redactSecrets(errorMessage(error));
        const reason =
          redacted
            .split(/\r?\n/)
            .find((line) => line.trim().length > 0)
            ?.trim() ?? "unknown";
        return { isError: true, content: reason };
      }
    },
  };
}
