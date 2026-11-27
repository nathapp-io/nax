import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AskRequest, AskResolver } from "#src/permissions/index";
import { askSummary, MAX_ASK_SUMMARY_CHARS } from "#src/tools/ask-request";
import type { CodingToolRuntime } from "#src/tools/index";
import { adaptProviderTool, compileToolPolicy, createCodingToolRuntime } from "#src/tools/index";
import type { ProviderTool } from "#src/tools/provider-types";
import type { ToolScope } from "#src/tools/types";
import { createWebExposure } from "#src/web/exposure";
import { createWebToolProvider, WEB_PROVIDER_ID } from "#src/web/provider";
import { assertDefined, cleanupTempDir, makeTempDir } from "#test/helpers/index";

/**
 * US-003: a tool's DECLARED summary-only fields, rendered on an approval line.
 *
 * The guarded-mode approval card for a memory tool read `MCP tool
 * nax-memory__save` / `nax-memory__save` — a line naming the tool twice and
 * nothing about the call. `ToolScope.summaryFields` is how a tool says which
 * plain input fields a human may be shown, so the card can say WHICH note is
 * about to be written.
 *
 * These fields are summary-only: they are never grant-checked, never treated as
 * paths or verbs, and never make a fieldless scope non-fieldless.
 */

const GHP = "ghp_abcdefghijklmnop1234";

describe("askSummary — summary fields", () => {
  test("AC-1: declared scalar fields render after the tool name, in declaration order", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["slug", "scope"] }, { slug: "a", scope: "project" });
    expect(s).toEqual({ summary: "T slug=a scope=project", unshowable: false });
  });

  test("AC-2: summary fields leave the line showable", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["slug", "scope"] }, { slug: "a", scope: "project" });
    expect(s.unshowable).toBe(false);
    // A MASKED summary field is still showable: masking is not withholding.
    // The redaction marker is what proves the declared field was RENDERED and
    // then masked -- "the line does not contain the secret" is also true of a
    // line that rendered no field at all.
    const masked = askSummary("T", { pathFields: [], summaryFields: ["token"] }, { token: GHP });
    expect(masked.unshowable).toBe(false);
    expect(masked.summary).toContain("[REDACTED:");
    expect(masked.summary).not.toContain(GHP);
  });

  test("AC-3: a declared field absent from the input adds nothing", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["slug", "type"] }, { slug: "a" });
    expect(s.summary).toBe("T slug=a");
  });

  test("AC-4: a number renders through String", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["n"] }, { n: 3 });
    expect(s.summary).toBe("T n=3");
  });

  test("AC-5: a boolean renders through String", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["f"] }, { f: true });
    expect(s.summary).toBe("T f=true");
  });

  test("AC-6: an object value is skipped, never serialised", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["o"] }, { o: { k: 1 } });
    expect(s.summary).toBe("T");
    // Not vacuous: a sibling scalar declared beside it still renders, so
    // "skip the object" is distinguishable from "render no fields at all".
    const mixed = askSummary("T", { pathFields: [], summaryFields: ["o", "slug"] }, { o: { k: 1 }, slug: "a" });
    expect(mixed.summary).toBe("T slug=a");
  });

  test("AC-7: an array value is skipped", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["xs"] }, { xs: ["a"] });
    expect(s.summary).toBe("T");
    const mixed = askSummary("T", { pathFields: [], summaryFields: ["xs", "slug"] }, { xs: ["a"], slug: "a" });
    expect(mixed.summary).toBe("T slug=a");
  });

  test("AC-8: LF and CRLF breaks in a value become one space each", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["d"] }, { d: "one\ntwo\r\nthree" });
    expect(s.summary).toBe("T d=one two three");
  });

  test("AC-8b: a lone CR break is flattened too", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["d"] }, { d: "one\rtwo" });
    expect(s.summary).toBe("T d=one two");
  });

  test("AC-9: path parts keep their place ahead of the summary fields", () => {
    const s = askSummary("T", { pathFields: ["path"], summaryFields: ["slug"] }, { path: "x", slug: "a" });
    expect(s.summary).toBe("T path=x slug=a");
  });

  test("AC-10: a secret in a summary field is masked, never rendered", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["token"] }, { token: GHP });
    expect(s.summary).not.toContain(GHP);
    // Which label the masker picks is its own business (`token=ghp_...` reads
    // as an assignment); that a mask was applied is this story's.
    expect(s.summary).toContain("[REDACTED:");
  });

  test("AC-11: a long summary field value is still capped at MAX_ASK_SUMMARY_CHARS", () => {
    const s = askSummary("T", { pathFields: [], summaryFields: ["v"] }, { v: "x".repeat(500) });
    expect(s.summary.length).toBeLessThanOrEqual(MAX_ASK_SUMMARY_CHARS);
    // Not vacuous: the field DID render, and only its tail was dropped.
    expect(s.summary.startsWith("T v=xxx")).toBe(true);
  });

  test("a scope without summaryFields renders exactly what it rendered before", () => {
    // The default: every tool that declares no summary fields is untouched.
    const s = askSummary("Read", { pathFields: ["path"] }, { path: "src/a.ts" });
    expect(s).toEqual({ summary: "Read path=src/a.ts", unshowable: false });
  });
});

function providerTool(overrides: Partial<ProviderTool> = {}): ProviderTool {
  return {
    localName: "save",
    description: "save a note",
    inputSchema: { type: "object", properties: {} },
    run: async () => ({ content: "saved" }),
    ...overrides,
  };
}

/**
 * The scope the session really runs the web fetch tool under: the provider's own
 * tool, through the one adaptation every provider tool goes through. Built here
 * rather than typed out, so a declaration that never reaches the tool cannot pass.
 */
async function adaptedFetchScope(): Promise<ToolScope> {
  const tools = await createWebToolProvider({
    exposure: createWebExposure(),
    maxResults: 5,
    fetch: { maxBytes: 1_000, timeoutMs: 1_000 },
    allowOrigins: [],
  }).tools("/tmp/nax-web-summary");
  const fetchTool = tools.find((tool) => tool.localName === "fetch");
  assertDefined(fetchTool, "the provider's fetch tool");
  return adaptProviderTool(WEB_PROVIDER_ID, fetchTool).scope;
}

describe("adaptProviderTool — summary fields", () => {
  test("AC-12: a provider tool's summaryFields reach the adapted tool's scope", () => {
    const adapted = adaptProviderTool("p", providerTool({ summaryFields: ["slug"] }));
    expect(adapted.scope.summaryFields).toEqual(["slug"]);
  });

  /**
   * US-003 (review-f32f-fixes): the web provider's fetch tool declares its
   * destination, so an approval card for a fetch names the URL it will read
   * instead of the tool name twice. Read through the REAL provider: the
   * declaration is only real if it is on the tool the session adapts.
   */
  test("AC-1: the adapted web fetch tool summarises as 'web__fetch url=<destination>'", async () => {
    const scope = await adaptedFetchScope();
    const s = askSummary("web__fetch", scope, { url: "https://docs.example.com/guide" });
    expect(s).toEqual({ summary: "web__fetch url=https://docs.example.com/guide", unshowable: false });
  });

  test("AC-1 control: the adapted web search tool declares no destination field", async () => {
    // The control: the fetch tool's scope is not simply "whatever the provider
    // built" -- the search tool beside it stays exactly the fieldless scope it
    // was, so the assertion above is the fetch tool's own declaration.
    const tools = await createWebToolProvider({
      exposure: createWebExposure(),
      search: { id: "tavily", search: async () => [] },
      maxResults: 5,
      fetch: { maxBytes: 1_000, timeoutMs: 1_000 },
      allowOrigins: [],
    }).tools("/tmp/nax-web-summary");
    const search = tools.find((tool) => tool.localName === "search");
    assertDefined(search, "the provider's search tool");
    expect(adaptProviderTool(WEB_PROVIDER_ID, search).scope).toEqual({ pathFields: [] });
  });

  test("AC-13: a provider tool without summaryFields adapts to exactly an empty fieldless scope", () => {
    const adapted = adaptProviderTool("p", providerTool());
    expect(adapted.scope).toEqual({ pathFields: [] });
  });
});

/**
 * AC-14: the seam the whole story exists for. A provider tool's declared
 * summary field is only real if it survives `adaptProviderTool`, the runtime's
 * scope lookup and `askSummary` into the request an AskResolver is handed.
 */
describe("createCodingToolRuntime — a provider tool's summary field reaches the ask request", () => {
  let root: string;

  beforeAll(() => {
    root = makeTempDir("nax-ask-summary-fields-");
  });

  afterAll(() => {
    cleanupTempDir(root);
  });

  test("AC-14: callTool hands the resolver 'p__save slug=a'", async () => {
    const requests: AskRequest[] = [];
    const recording: AskResolver = {
      resolve: (request) => {
        requests.push(request);
        return Promise.resolve({ decision: "allow", decidedBy: "human", latencyMs: 0 });
      },
    };
    const runtime = askRuntime(root, recording);

    const outcome = await runtime.callTool("p__save", { slug: "a" });

    expect(outcome.kind).toBe("ok");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.summary).toBe("p__save slug=a");
  });

  test("an unconditional ask rule still asks for a summary-carrying fieldless tool", async () => {
    // `summaryFields` must not count as a field for `isFieldlessScope`: an
    // unconditional ask on a memory tool has to keep asking exactly as today.
    const asked: AskRequest[] = [];
    const recording: AskResolver = {
      resolve: (request) => {
        asked.push(request);
        return Promise.resolve({ decision: "deny", decidedBy: "human", latencyMs: 0 });
      },
    };
    const runtime = askRuntime(root, recording);

    const outcome = await runtime.callTool("p__save", { slug: "a" });

    expect(outcome.kind).toBe("denied");
    expect(asked).toHaveLength(1);
  });
});

function askRuntime(root: string, askResolver: AskResolver): CodingToolRuntime {
  return createCodingToolRuntime({
    policy: compileToolPolicy([{ tool: "p__save", patterns: ["*"] }], root, {
      askRules: [{ tool: "p__save", patterns: ["*"] }],
    }),
    askResolver,
    extraTools: [adaptProviderTool("p", providerTool({ summaryFields: ["slug"] }))],
  });
}
