/**
 * US-006 — the fields the memory tools declare for an approval line.
 *
 * `save` and `forget` declare plain input fields (`summaryFields`) so a person
 * approving one reads WHICH note is about to be written or retired instead of the
 * same line the tool always rendered. `get` and `search` declare none: they change
 * nothing, and the note BODY is never shown on an approval line — it is the note's
 * content, not a label for the call.
 *
 * The declaration alone proves nothing; US-003's adapter and `askSummary` are what
 * carry it there. So the last two cases run the REAL save tool through
 * `adaptProviderTool` and `createCodingToolRuntime` with an unconditional ask rule,
 * and assert on the summary a recording resolver actually receives — never on a
 * string this file reconstructed itself.
 *
 * The host is the shared fake: the ask denies before the tool runs, so nothing is
 * written and the provider's shape is the whole subject.
 */

import { describe, expect, test } from "bun:test";
import type { AskResolver, ProviderTool } from "@nathapp/nax-agent";
import { adaptProviderTool, compileToolPolicy, createCodingToolRuntime } from "@nathapp/nax-agent";
import { makeFakeMemoryHost } from "@test/helpers";
import { createMemoryToolProvider } from "@/memory";

/** The permitted root the runtime and the policy are compiled against. */
const ROOT = "/repo";

/** The tool provider under test, over a host no case reaches. */
const provider = createMemoryToolProvider(makeFakeMemoryHost("the ask denies before the tool runs"));

/** The tool of the provider's `tools()` list that goes by `name`. */
async function toolFor(name: string): Promise<ProviderTool> {
  const tool = (await provider.tools(ROOT)).find((candidate) => candidate.localName === name);
  if (tool === undefined) throw new Error(`provider has no tool ${name}`);
  return tool;
}

/** What an `AskResolver` was handed, kept so the seam cases can read it after the call. */
interface RecordedAsks {
  readonly resolver: AskResolver;
  readonly summaries: string[];
  readonly rules: string[];
}

/** An `AskResolver` that records the request it received and denies it. */
function denyingRecorder(): RecordedAsks {
  const summaries: string[] = [];
  const rules: string[] = [];
  const resolver: AskResolver = {
    resolve: (request) => {
      summaries.push(request.summary);
      rules.push(request.rule);
      return Promise.resolve({ decision: "deny", decidedBy: "human", latencyMs: 1 });
    },
  };
  return { resolver, summaries, rules };
}

describe("createMemoryToolProvider — summaryFields", () => {
  test("AC-6 save declares the four plain fields of the note it would write", async () => {
    expect((await toolFor("save")).summaryFields).toEqual(["scope", "slug", "type", "description"]);
  });

  test("AC-7 forget declares the note it would retire and the reason", async () => {
    expect((await toolFor("forget")).summaryFields).toEqual(["scope", "slug", "reason"]);
  });

  test("AC-8 get declares no summary field", async () => {
    expect((await toolFor("get")).summaryFields).toBeUndefined();
  });

  test("AC-9 search declares no summary field", async () => {
    expect((await toolFor("search")).summaryFields).toBeUndefined();
  });

  test("the note body is never a summary field, on save or on forget", async () => {
    const declared = [(await toolFor("save")).summaryFields, (await toolFor("forget")).summaryFields].flat();

    expect(declared).not.toContain("body");
    expect(declared).not.toContain("text");
  });
});

describe("the memory save approval line, end to end", () => {
  /** The runtime over the real adapted save tool, with the wildcard grant and ask rule. */
  async function runtimeWithSave(resolver: AskResolver) {
    const save = adaptProviderTool("nax-memory", await toolFor("save"));
    return createCodingToolRuntime({
      extraTools: [save],
      policy: compileToolPolicy([{ tool: "nax-memory__save", patterns: ["*"] }], ROOT, {
        askRules: [{ tool: "nax-memory__save", patterns: ["*"] }],
      }),
      askResolver: resolver,
    });
  }

  /** The chat-smoke save the story's AC calls. */
  const CHAT_SMOKE_SAVE = {
    scope: "project",
    slug: "chat-smoke",
    type: "feedback",
    description: "Chat smoke note",
    body: "b",
  };

  test("AC-10 hands the resolver the declared fields, and never the body", async () => {
    const recorded = denyingRecorder();
    const runtime = await runtimeWithSave(recorded.resolver);

    await runtime.callTool("nax-memory__save", CHAT_SMOKE_SAVE);

    expect(recorded.summaries).toEqual([
      "nax-memory__save scope=project slug=chat-smoke type=feedback description=Chat smoke note",
    ]);
    expect(recorded.summaries[0]).not.toContain("body=");
  });

  test("AC-11 a denied ask stays a denial, so summaryFields never widen the rule", async () => {
    const recorded = denyingRecorder();
    const runtime = await runtimeWithSave(recorded.resolver);

    const outcome = await runtime.callTool("nax-memory__save", CHAT_SMOKE_SAVE);

    expect(outcome.kind).toBe("denied");
    // The unconditional rule is why the resolver was consulted at all: a scope
    // carrying summaryFields must still read as fieldless to the ask gate, or
    // the wildcard rule silently stops applying.
    expect(recorded.rules).toEqual(["nax-memory__save"]);
  });
});
