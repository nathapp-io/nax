/**
 * US-020 — the run surface lock.
 *
 * `chat.web.enabled` is a *chat* policy. A story session dispatched by `nax run` resolves its
 * providers through `resolveProviderContribution`, whose only inputs are the profile, the
 * configured providers and the root — nothing there reads `chat.web`. This file pins that: with
 * the web switched on for chat, a run still advertises exactly the providers it advertised with
 * the web switched off, and never a provider whose id is `web`.
 *
 * It is a lock rather than a bug fix: US-018 confined the web provider to `openChatSession`, and
 * `scripts/check-web-chat-only.ts` keeps the factories out of every other module. If a later
 * change ever threads the chat provider into the run's provider assembly, the difference between
 * the two resolutions below is what fails first.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ProviderTool, ToolProvider } from "@nathapp/nax-agent";
import { cleanupTempDir, makeNaxConfig, makeTempDir } from "@test/helpers";
import { resolveProviderContribution } from "@/agents/coding-tool-support-resolve";
import { type NaxConfig, resolvePermissions } from "@/config";

/** The provider id the chat wiring gives its web provider, and the one the run must never see. */
const WEB_PROVIDER_ID = "web";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-web-run-surface-");
});

afterEach(() => cleanupTempDir(root));

/** One discovered MCP-shaped provider, standing in for whatever a run does configure. */
function fakeProvider(id: string, localNames: readonly string[]): ToolProvider {
  const tools: ProviderTool[] = localNames.map((localName) => ({
    localName,
    description: `${localName} description`,
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "ok" }),
  }));
  return { id, kind: "discovered", stages: ["*"], tools: async () => tools };
}

/** A run-shaped config, with `chat.web.enabled` on or off and nothing else changed. */
function runConfig(webEnabled: boolean): NaxConfig {
  return makeNaxConfig({ chat: { web: { enabled: webEnabled } } });
}

/** The provider ids a `nax run` story session resolves for this config. */
async function runSurfaceProviderIds(config: NaxConfig): Promise<string[]> {
  const resolved = resolvePermissions(config, "run");
  const contribution = await resolveProviderContribution(
    resolved,
    { config, pipelineStage: "run", providers: [fakeProvider("context7", ["query-docs"])] },
    root,
  );
  return contribution.providerResult.entries.map((entry) => entry.providerId);
}

describe("run surface with chat.web.enabled true", () => {
  test("AC-7: resolves no provider whose id is web", async () => {
    const ids = await runSurfaceProviderIds(runConfig(true));

    // The positive control: resolution really ran, so the absence below is an absence.
    expect(ids).toEqual(["context7"]);
    expect(ids).not.toContain(WEB_PROVIDER_ID);
  });

  test("enabling the chat web changes nothing a run session is given", async () => {
    const withoutWeb = await runSurfaceProviderIds(runConfig(false));
    const withWeb = await runSurfaceProviderIds(runConfig(true));

    expect(withWeb).toEqual(withoutWeb);
  });
});
