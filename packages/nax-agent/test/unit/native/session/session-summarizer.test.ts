/**
 * #2846: the summarize closure releases its per-call signal once the call settles.
 *
 * `AbortSignal.any` keeps a combined signal that has abort listeners alive for as long as
 * one of its sources can still abort. The operation's signal outlives every summary call,
 * so an unreleased per-call signal stayed reachable for the rest of the session.
 */
import { describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { DEFAULT_COMPACTION } from "#src/native/session/compaction-settings";
import { createSessionSummarizer, type SessionModelResolution } from "#src/native/session/session-summarizer";
import { createTurnDeadline } from "#src/session/turn-deadline";
import { withDerivedStream } from "#test/helpers/index";

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function resolution(complete: Client["complete"]): SessionModelResolution {
  const client = withDerivedStream({
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => MODEL.pricing,
    stream: async function* stream() {},
    complete,
    validate: () => {},
  });
  return {
    client,
    model: MODEL,
    provider: "openai",
    thinking: undefined,
    rates: MODEL.pricing,
    pricingSource: "catalog-rates",
    contextWindow: MODEL.contextWindow,
    compaction: DEFAULT_COMPACTION,
    sessionId: "sess-summarizer",
  };
}

describe("createSessionSummarizer", () => {
  test("a settled call's signal is aborted; the operation's signal is not", async () => {
    const operation = new AbortController();
    const seen: AbortSignal[] = [];
    const summarize = createSessionSummarizer({
      resolution: resolution(async (_model, req) => {
        if (req.signal !== undefined) seen.push(req.signal);
        return { text: "summary", usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "stop" };
      }),
      deadline: createTurnDeadline(60),
      signal: operation.signal,
    });

    const result = await summarize([]);

    expect(result.text).toBe("summary");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
    expect(operation.signal.aborted).toBe(false);
  });

  test("a failed call's signal is released too", async () => {
    const seen: AbortSignal[] = [];
    const summarize = createSessionSummarizer({
      resolution: resolution(async (_model, req) => {
        if (req.signal !== undefined) seen.push(req.signal);
        throw new Error("upstream 500");
      }),
      deadline: createTurnDeadline(60),
      signal: new AbortController().signal,
    });

    await expect(summarize([])).rejects.toThrow("upstream 500");
    expect(seen[0]?.aborted).toBe(true);
  });

  test("an operation cancel still reaches an in-flight call", async () => {
    const operation = new AbortController();
    const summarize = createSessionSummarizer({
      resolution: resolution(
        (_model, req) =>
          new Promise((_resolve, reject) => {
            req.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          }),
      ),
      deadline: createTurnDeadline(60),
      signal: operation.signal,
    });

    const pending = summarize([]);
    operation.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
