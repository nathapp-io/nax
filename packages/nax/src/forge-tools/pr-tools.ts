import type { ProviderTool } from "@nathapp/nax-agent";
import type { ForgeCheck, PrRef } from "@/forge";
import { _forgeToolsDeps } from "./deps";
import { fitToolResult } from "./fit-result";
import { wrapForgeTool } from "./tool";
import type { ForgeReadBinding } from "./types";

function validateEmptyInput(input: Record<string, unknown>): string | undefined {
  const field = Object.keys(input)[0];
  return field === undefined ? undefined : `Unexpected field: ${field}`;
}

function checkEntry(check: ForgeCheck): string {
  return [
    `id: ${check.id}`,
    `name: ${check.name}`,
    `status: ${check.status}`,
    ...(check.status === "completed" && check.conclusion !== undefined ? [`conclusion: ${check.conclusion}`] : []),
    ...(check.url ? [`url: ${check.url}`] : []),
  ].join(" | ");
}

/** List checks only for the bound PR's freshly read current head. */
export function checksTool(binding: ForgeReadBinding, resolveRef: () => Promise<PrRef>): ProviderTool {
  return wrapForgeTool(
    {
      localName: "checks",
      description: "List checks for the bound PR's current head.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: validateEmptyInput,
      async read(ref, _input, ctx) {
        const info = await _forgeToolsDeps.readPrInfo(ref, binding.deps, binding.cwd);
        const checks = await _forgeToolsDeps.listHeadChecks(ref, info.headSha, binding.deps, binding.cwd);
        return {
          content: fitToolResult(
            { header: ["Head checks"], entries: checks.map(checkEntry), footer: [] },
            ctx.maxBytes,
            "start",
          ),
        };
      },
    },
    resolveRef,
  );
}

/** Read current metadata without exposing the description body. */
export function prTool(binding: ForgeReadBinding, resolveRef: () => Promise<PrRef>): ProviderTool {
  return wrapForgeTool(
    {
      localName: "pr",
      description: "Read metadata of the bound PR (not its description body).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: validateEmptyInput,
      async read(ref, _input, ctx) {
        const info = await _forgeToolsDeps.readPrInfo(ref, binding.deps, binding.cwd);
        const entries = [
          `number: ${info.number}`,
          `state: ${info.state}`,
          `draft: ${info.draft}`,
          `base: ${info.baseRef}`,
          `head: ${info.headRef}`,
          `sha: ${info.headSha}`,
          `url: ${info.url}`,
          `title: ${info.title}`,
        ];
        return { content: fitToolResult({ header: ["Bound PR"], entries, footer: [] }, ctx.maxBytes, "start") };
      },
    },
    resolveRef,
  );
}
