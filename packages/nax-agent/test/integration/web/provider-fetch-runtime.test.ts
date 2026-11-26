/**
 * The web provider's fetch tool inside a real coding-tool runtime: a static provider's tools are
 * granted by advertising them alone, so an ask-profile session that asks before running
 * DISCOVERED tools still runs `web__fetch` without putting it to the person -- and the call's
 * audit row carries the URL it fetched.
 *
 * The page seam is replaced with a stand-in, so no call here reaches the network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chainAskLinks } from "#src/permissions/index";
import { buildSessionToolSupport, SESSION_STAGE } from "#src/session/session-tool-support";
import { compileToolPolicy } from "#src/tools/policy";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import { resolveProviderTools } from "#src/tools/provider-advertise";
import { createCodingToolRuntime } from "#src/tools/runtime";
import type { ToolAuditSink, ToolCallRecord } from "#src/tools/tool-audit";
import { createWebExposure, type WebExposure } from "#src/web/exposure";
import type { WebPage } from "#src/web/fetch-page";
import { _webProviderDeps, createWebToolProvider, type WebToolProviderOptions } from "#src/web/provider";
import { cleanupTempDir, makeTempDir } from "#test/helpers/index";

const EMPTY_PATHS: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };

/** The url the fetch is asked for, and the page the seam answers with. */
const URL_ASKED = "https://a.example/p";

const tempDirs: string[] = [];

/** The real page seam, restored after every test. */
const realFetchWebPage = _webProviderDeps.fetchWebPage;

function tempRoot(): string {
  const root = makeTempDir("nax-web-fetch-");
  tempDirs.push(root);
  return root;
}

/** A page the seam answers with, so a successful call has something to fence. */
function readablePage(url: string): WebPage {
  return {
    url,
    status: 200,
    contentType: "text/html",
    text: "hi",
    links: [],
    truncated: false,
    unsupported: false,
  };
}

/** Replace the page seam with one answering `page`, so no fetch in this file reaches a socket. */
function stubPage(page: WebPage): void {
  _webProviderDeps.fetchWebPage = async () => page;
}

/** A provider for one session, with its own exposure. */
function provider(exposure: WebExposure): ReturnType<typeof createWebToolProvider> {
  const opts: WebToolProviderOptions = {
    exposure,
    maxResults: 5,
    fetch: { maxBytes: 1_000, timeoutMs: 1_000 },
    allowOrigins: [],
  };
  return createWebToolProvider(opts);
}

afterEach(() => {
  _webProviderDeps.fetchWebPage = realFetchWebPage;
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

describe("the fetch tool in a session runtime", () => {
  test("AC-14: a web__fetch call runs under an ask profile without consulting the ask resolver", async () => {
    // "ask" asks before every discovered tool; "full" asks only because `askDiscoveredTools` is
    // on. Both postures must leave a static provider's tool unasked, so both are exercised.
    for (const profile of ["ask", "full"] as const) {
      const root = tempRoot();
      const exposure = createWebExposure();
      const asked: string[] = [];
      stubPage(readablePage(URL_ASKED));
      const providerTools = await resolveProviderTools([provider(exposure)], SESSION_STAGE, root);
      // The premise of the test: a static provider contributes no ask-tool, so nothing about
      // this session's posture can route web__fetch through the resolver below.
      expect(providerTools.askTools).toBeUndefined();

      const { support } = buildSessionToolSupport({
        profile,
        root,
        sessionName: `web-fetch-runtime-${profile}`,
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

      const outcome = await support.runtime.callTool("web__fetch", { url: URL_ASKED });

      expect({ profile, asked }).toEqual({ profile, asked: [] });
      expect({ profile, kind: outcome.kind }).toEqual({ profile, kind: "ok" });
      expect({ profile, exposed: exposure.isExposed() }).toEqual({ profile, exposed: true });
    }
  });
});

describe("the fetch tool's audit row", () => {
  test("AC-15: the web__fetch call ledgers with the input url", async () => {
    const root = tempRoot();
    stubPage(readablePage(URL_ASKED));
    const providerTools = await resolveProviderTools([provider(createWebExposure())], SESSION_STAGE, root);
    const captured: ToolCallRecord[] = [];
    const sink: ToolAuditSink = {
      record(entry) {
        captured.push(entry);
      },
      async flush() {},
    };
    const runtime = createCodingToolRuntime({
      policy: compileToolPolicy([{ tool: "web__fetch", patterns: ["*"] }], root),
      extraTools: providerTools.tools,
      providerIdByTool: providerTools.providerIdByTool,
      sink,
    });

    const outcome = await runtime.callTool("web__fetch", { url: URL_ASKED });

    expect(outcome.kind).toBe("ok");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.input).toEqual({ url: URL_ASKED });
    expect(captured[0]?.provider).toBe("web");
  });
});
