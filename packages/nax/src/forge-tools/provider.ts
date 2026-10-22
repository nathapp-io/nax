/** PR-bound forge context; independent of the tool run's permitted working root. */
import type { ProviderTool, ToolProvider } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import { prNumberFromUrl } from "@/forge";
import { buildForgeReadInstructions } from "@/prompts";
import { FORGE_READ_PROVIDER_ID } from "./constants";
import { _forgeToolsDeps } from "./deps";
import { fitToolResult } from "./fit-result";
import { wrapForgeTool } from "./tool";
import type { ForgeReadBinding } from "./types";

/** Share successful and in-flight resolutions, but never cache a rejection. */
function sharedReference(binding: ForgeReadBinding): () => Promise<PrRef> {
  let pending: Promise<PrRef> | undefined;
  return () => {
    pending ??= Promise.resolve()
      .then(() => binding.resolveRef())
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}

/** Minimal metadata read; the dedicated PR/check handlers extend this core. */
function prTool(binding: ForgeReadBinding, resolveRef: () => Promise<PrRef>): ProviderTool {
  return wrapForgeTool(
    {
      localName: "pr",
      description: "Read metadata of the bound PR (not its description body).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      validate: (input) => (Object.keys(input).length ? `Unexpected field: ${Object.keys(input)[0]}` : undefined),
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

export function createForgeReadProvider(binding: ForgeReadBinding): ToolProvider {
  const resolveRef = sharedReference(binding);
  const tools = [prTool(binding, resolveRef)];
  return {
    id: FORGE_READ_PROVIDER_ID,
    kind: "static",
    stages: ["*"],
    tools: async () => tools,
    instructions: async () => buildForgeReadInstructions(),
  };
}

export function forgeReadProviderForUrl(url: string, deps: ForgeDeps, cwd: string): ToolProvider {
  return createForgeReadProvider({
    deps,
    cwd,
    async resolveRef() {
      const number = prNumberFromUrl(url);
      if (number === null) {
        throw new NaxError(`[forge-tools] No PR number in URL: ${url}`, "FORGE_PR_REF_UNRESOLVED", {
          stage: "forge-tools",
        });
      }
      return _forgeToolsDeps.resolvePrRef(number, deps, cwd);
    },
  });
}
