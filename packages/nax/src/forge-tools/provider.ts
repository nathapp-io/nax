/** PR-bound forge context; independent of the tool run's permitted working root. */
import type { ToolProvider } from "@nathapp/nax-agent";
import { NaxError } from "@/errors";
import type { ForgeDeps, PrRef } from "@/forge";
import { prNumberFromUrl } from "@/forge";
import { buildForgeReadInstructions } from "@/prompts";
import { FORGE_READ_PROVIDER_ID } from "./constants";
import { _forgeToolsDeps } from "./deps";
import { logTool } from "./log-tool";
import { checksTool, prTool } from "./pr-tools";
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

export function createForgeReadProvider(binding: ForgeReadBinding): ToolProvider {
  const resolveRef = sharedReference(binding);
  const tools = [prTool(binding, resolveRef), checksTool(binding, resolveRef), logTool(binding, resolveRef)];
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
