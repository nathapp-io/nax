/**
 * The web provider inside a real coding-tool runtime: a static provider's tools are granted by
 * advertising them alone, so an ask-profile session that asks before running DISCOVERED tools
 * still runs `web__search` without putting it to the person.
 *
 * The backend is a stand-in, so no call here reaches a search API.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chainAskLinks } from "#src/permissions/index";
import { buildSessionToolSupport, SESSION_STAGE } from "#src/session/session-tool-support";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import { resolveProviderTools } from "#src/tools/provider-advertise";
import { createWebExposure } from "#src/web/exposure";
import { createWebToolProvider } from "#src/web/provider";
import type { SearchBackend } from "#src/web/search-backend";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const EMPTY_PATHS: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };

const tempDirs: string[] = [];

function tempRoot(): string {
  const root = makeTempDir("nax-web-provider-");
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

/** A backend answering with one result, so a successful call has something to fence. */
function oneResult(): SearchBackend {
  return {
    id: "tavily",
    search: async () => [{ title: "Title", url: "https://a.example/", snippet: "snippet" }],
  };
}

describe("the web provider in a session runtime", () => {
  test("AC-19: a web__search call runs under an ask profile without consulting the ask resolver", async () => {
    // "ask" asks before every discovered tool; "full" asks only because `askDiscoveredTools` is
    // on. Both postures must leave a static provider's tool unasked, so both are exercised.
    for (const profile of ["ask", "full"] as const) {
      const root = tempRoot();
      const exposure = createWebExposure();
      const asked: string[] = [];
      const provider = createWebToolProvider({
        exposure,
        search: oneResult(),
        maxResults: 5,
        fetch: { maxBytes: 1_000, timeoutMs: 1_000 },
        allowOrigins: [],
      });
      const providerTools = await resolveProviderTools([provider], SESSION_STAGE, root);
      // The premise of the test: a static provider contributes no ask-tool, so nothing about
      // this session's posture can route web__search through the resolver below.
      expect(providerTools.askTools).toBeUndefined();

      const { support } = buildSessionToolSupport({
        profile,
        root,
        sessionName: `web-provider-runtime-${profile}`,
        protectedPaths: EMPTY_PATHS,
        bashApproval: "gated",
        launcher: undefined,
        interceptor: undefined,
        askDiscoveredTools: true,
        providerTools,
        askResolver: chainAskLinks([
          {
            name: "recording",
            async resolve(req) {
              asked.push(req.tool ?? "");
              return { decision: "deny", decidedBy: "human" as const };
            },
          },
        ]),
      });

      const outcome = await support.runtime.callTool("web__search", { query: "q" });

      expect({ profile, asked }).toEqual({ profile, asked: [] });
      expect({ profile, kind: outcome.kind }).toEqual({ profile, kind: "ok" });
      expect({ profile, exposed: exposure.isExposed() }).toEqual({ profile, exposed: true });
    }
  });
});
