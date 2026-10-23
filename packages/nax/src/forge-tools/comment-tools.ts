import type { ProviderTool } from "@nathapp/nax-agent";
import type { PrRef, WriterCheck } from "@/forge";
import { FORGE_MAX_COMMENTS } from "./constants";
import { _forgeToolsDeps } from "./deps";
import { fitToolResult } from "./fit-result";
import { renderWriterComment, writerComments } from "./thread-tools";
import { wrapForgeTool } from "./tool";
import type { ForgeReadBinding } from "./types";

/** Read all authors before selecting the latest writer-authored comments and review bodies. */
export function commentsTool(
  binding: ForgeReadBinding,
  resolveRef: () => Promise<PrRef>,
  check: WriterCheck,
): ProviderTool {
  return wrapForgeTool(
    {
      localName: "comments",
      description: "Read the latest writer-authored PR comments and review bodies, oldest first.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate(input) {
        const unknown = Object.keys(input)[0];
        return unknown === undefined ? undefined : `Unexpected field: ${unknown}`;
      },
      async read(ref, _input, ctx) {
        const filtered = await writerComments(
          await _forgeToolsDeps.listPrComments(ref, binding.deps, binding.cwd),
          check,
        );
        const ordered = filtered.comments.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const notShown = Math.max(0, ordered.length - FORGE_MAX_COMMENTS);
        const footer = [
          ...(notShown ? [`${notShown} earlier comment(s) not shown`] : []),
          ...(filtered.withheld ? [`withheld ${filtered.withheld} comment(s) from authors without write access`] : []),
        ];
        return {
          content: fitToolResult(
            { header: ["PR comments"], entries: ordered.slice(notShown).map(renderWriterComment), footer },
            ctx.maxBytes,
            "start",
          ),
        };
      },
    },
    resolveRef,
  );
}
